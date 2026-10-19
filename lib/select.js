/**
 * 选站：纯函数，不碰 IO、不改状态。输入"池 + 配置 + 账本 + 当前路由"，输出"选哪条"。
 *
 * 排序口径：
 *   原地可用（preferCurrent） > 可用性（未冷却、未满载、未超速率） > 成本升序 > 归一化负载升序 > 最久没被选中的优先
 * 也就是：请求本来就能走原来那个站，就别动它（换一次站，那站的上下文前缀缓存白算）；
 * 原地扛不住了才在池内挑 —— 能用便宜的就不选贵的；同价里选更闲的；同价同闲时打散。
 *
 * 一条硬约束：**只在同一个 pool 内换**。跨 pool 就是换模型能力，那是用户的选择，插件不替他做。
 */

export function routeId(route) {
  return `${route.provider}/${route.model}`
}

/** 找出包含这条路由的池子（第一条匹配的池子生效）。 */
export function poolFor(config, route) {
  if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return null
  for (const pool of config.pools) {
    if (pool.routes.some((r) => r.provider === route.provider && r.model === route.model)) return pool
  }
  return null
}

function relayOf(config, provider) {
  const entry = config.relays instanceof Map ? config.relays.get(provider) : undefined
  return {
    cost: entry?.cost ?? config.defaultCost,
    concurrency: entry?.concurrency ?? config.defaultConcurrency,
    account: entry?.account ?? provider,
    // 0 / 缺失 = 不限
    rpm: entry?.rpm && entry.rpm > 0 ? entry.rpm : Infinity,
    minGapMs: entry?.minGapMs && entry.minGapMs > 0 ? entry.minGapMs : 0,
  }
}

/** 速率闸门的软越界：并发之外的第二道门，返回值只用来在"全都不可用"时排序。 */
function breachesRate(candidate, ledger) {
  if (Number.isFinite(candidate.rpm) && ledger.hitsOf(candidate.account) >= candidate.rpm) return true
  return candidate.minGapMs > 0 && ledger.sinceLastHit(candidate.account) < candidate.minGapMs
}

/**
 * @returns {{route: {provider: string, model: string} | null, reason: string, skipped: string[]}}
 */
export function selectRoute({ pool, config, ledger, sessionKey, current = null, now = Date.now() }) {
  const skipped = []
  const costs = [...new Set(pool.routes.map((route) => relayOf(config, route.provider).cost))].sort((a, b) => a - b)
  const costRank = (cost) => (costs.indexOf(cost) === -1 ? costs.length : costs.indexOf(cost))

  const candidates = pool.routes.map((route) => {
    const relay = relayOf(config, route.provider)
    return { route, ...relay }
  })

  const healthy = []
  for (const candidate of candidates) {
    const cooldown = ledger.cooldownOf(candidate.route.provider)
    if (cooldown) {
      skipped.push(`${routeId(candidate.route)} 冷却剩 ${Math.ceil((cooldown.until - now) / 1000)}s（${cooldown.code}，第 ${cooldown.fails} 次）`)
      continue
    }
    const inflight = ledger.inflightOf(candidate.account)
    if (inflight >= candidate.concurrency) {
      skipped.push(`${routeId(candidate.route)} 满载 ${inflight}/${candidate.concurrency}`)
      continue
    }
    // 速率闸门：并发上限抓不住密度（12 路短请求每秒能发十几次，但在飞始终不到上限）。
    const hits = ledger.hitsOf(candidate.account)
    if (Number.isFinite(candidate.rpm) && hits >= candidate.rpm) {
      skipped.push(`${routeId(candidate.route)} 速率已满 ${hits}/${candidate.rpm} 次每分`)
      continue
    }
    if (candidate.minGapMs > 0) {
      const gap = ledger.sinceLastHit(candidate.account)
      if (gap < candidate.minGapMs) {
        skipped.push(`${routeId(candidate.route)} 距上次请求 ${Math.round(gap)}ms（下限 ${candidate.minGapMs}ms）`)
        continue
      }
    }
    healthy.push({ ...candidate, inflight, load: inflight / Math.max(1, candidate.concurrency) })
  }

  if (healthy.length > 0) {
    // 原地可用就不换站。注意 incoming 的 provider/model 每次请求都来自配置（不是上一次改过的那个），
    // 所以这条等价于"谁起始在哪儿就留在哪儿"：主会话留在 zxcbug、子代理留在 bree，
    // 只有原地冷却/满载/超速率时才切到同池的备用站。
    if (config.preferCurrent && current) {
      const keep = healthy.find((c) => c.route.provider === current.provider && c.route.model === current.model)
      if (keep) {
        return {
          route: keep.route,
          reason: `原地可用（${routeId(keep.route)}，在飞 ${keep.inflight}/${keep.concurrency}），不换站`,
          skipped,
        }
      }
      skipped.push(`原配置 ${current.provider}/${current.model} 本轮不可用，改走同池备用站`)
    }

    // 粘性：还在健康的候选里、且成本排名不超过阈值，就留在上次那个站。
    // 用"成本排名"而不是"1.5 倍价格"之类的倍数判据 —— 后者在 cost=0 或未配置时会算错。
    if (config.stickiness) {
      const sticky = ledger.sessionRoute(sessionKey)
      if (sticky) {
        const hit = healthy.find((c) => c.route.provider === sticky.provider && c.route.model === sticky.model)
        if (hit && costRank(hit.cost) <= config.stickinessMaxRank) {
          return { route: hit.route, reason: `粘住上次的 ${routeId(hit.route)}（排名 ${costRank(hit.cost)}，在飞 ${hit.inflight}/${hit.concurrency}）`, skipped }
        }
        if (hit) skipped.push(`上次的 ${routeId(hit.route)} 成本排名 ${costRank(hit.cost)} 超过阈值 ${config.stickinessMaxRank}，改走更便宜的`)
      }
    }

    healthy.sort((a, b) =>
      a.cost - b.cost ||
      a.load - b.load ||
      ledger.lastPickedAt(a.route) - ledger.lastPickedAt(b.route))

    const best = healthy[0]
    const why = healthy.length === 1
      ? `唯一可用（在飞 ${best.inflight}/${best.concurrency}）`
      : `最便宜可用（cost=${best.cost}，在飞 ${best.inflight}/${best.concurrency}，负载比 ${best.load.toFixed(2)}）`
    return { route: best.route, reason: why, skipped }
  }

  // 全都满载：忽略并发上限，取归一化负载最小的。宁可多压一点也不要卡住整个回合。
  // 但速率闸门是"软"的：先挑没超速率的；整池都超了才硬发（比让回合卡死好）。
  const alive = candidates.filter((candidate) => !ledger.cooldownOf(candidate.route.provider))
  if (alive.length === 0) {
    return { route: null, reason: '池内所有站在冷却中，本轮不改动请求', skipped }
  }
  const loadOf = (candidate) => ledger.inflightOf(candidate.account) / Math.max(1, candidate.concurrency)
  alive.sort((a, b) =>
    Number(breachesRate(a, ledger)) - Number(breachesRate(b, ledger)) ||
    loadOf(a) - loadOf(b) ||
    a.cost - b.cost ||
    ledger.lastPickedAt(a.route) - ledger.lastPickedAt(b.route))
  const best = alive[0]
  const inflight = ledger.inflightOf(best.account)
  const note = breachesRate(best, ledger) ? '，速率也已超（整池都超了）' : ''
  return { route: best.route, reason: `全部满载，取负载最小的 ${routeId(best.route)}（在飞 ${inflight}/${best.concurrency}${note}）`, skipped }
}
