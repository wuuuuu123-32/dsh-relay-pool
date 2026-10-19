/**
 * 记账本：谁在飞（inflight）、谁在冷却（cooldown）、每个会话粘在哪个站（sticky）。
 *
 * 关于并发的两个坑（会审时点出来的）：
 * 1. 计数不能放在 "返回生成器之前" —— 消费者可能永远不 next()，那样 finally 永不执行，
 *    计数永久偏高。所以 attach 只把「预留」转成「在飞」，真正的加减在生成器体内。
 * 2. 但只靠生成器体内的加减会有羊群效应：同一 tick 里多个子代理都看到 0 在飞，全选最便宜的站。
 *    所以选择阶段先 reserve 占位，pending 也计入 inflight；stream 启动时 attach 把占位转正在飞
 *    （不重复计数），结束 release。没等到 stream 的占位由 sweep 按 reserveTtlMs 清掉。
 */

// 在飞条目多久没有新 chunk 就判定为"被遗弃的生成器"。
// 用「空闲时长」而不是「总时长」：真正在生成的长请求会一直 touch，不会被误清；
// 而消费者拿到生成器后既不继续 next 也不调用 return 的那种泄漏，2 分钟就回收。
const ACTIVE_IDLE_MS = 120_000
// 一次失败已经在 llm/stream 里记过时，紧跟其后的 agent/request-error 不再重复记。
const SETTLE_DEDUPE_MS = 5_000

export class Ledger {
  constructor({ now = () => Date.now(), configOf = () => null } = {}) {
    this.now = now
    this.configOf = configOf
    /** @type {Map<string, {route: {provider: string, model: string}, at: number}>} */
    this.pending = new Map()
    /** @type {Map<string, {route: {provider: string, model: string}, at: number}>} */
    this.active = new Map()
    /** @type {Map<string, {until: number, fails: number, code: string, at: number}>} */
    this.cooldowns = new Map()
    /** @type {Map<string, {provider: string, model: string, poolId: string, at: number}>} */
    this.sessions = new Map()
    /** @type {Map<string, number>} */
    this.lastPicked = new Map()
    /** @type {Map<string, {at: number, provider: string}>} 去重用：最近一次已结算的尝试 */
    this.settles = new Map()
    /** @type {Map<string, number[]>} 速率闸门：每个账号最近若干次占位的时刻（按 60 秒窗口裁剪） */
    this.hits = new Map()
    /** @type {Map<string, number>} 每个账号最后一次请求的时刻（和窗口分开存：窗口只留 60 秒，这里要管 minGapMs） */
    this.lastHit = new Map()
    this.anonSeq = 0
    this.stats = { reservations: 0, switches: 0, failures: 0, cooldownHits: 0, reached: 0, sweeps: 0 }
  }

  // ── 并发名额 ────────────────────────────────────────────────────────

  /** 占位。速率总是记；并发名额在拿不到会话 id 时用匿名 key 占（配 sweep 兜底回收）。 */
  reserve(sessionKey, route) {
    // 速率记账放在这里（而不是流启动时）：同一 tick 涌进来的几个请求，只有先记账才看得见彼此。
    // 会审意见：占位要原子、且"确定没发出去"时必须能撤销 —— 见 undoReservation。
    const hitAt = this.markHit(this._accountOf(route.provider))
    this.stats.reservations += 1
    this.stats.reached += 1
    const named = typeof sessionKey === 'string' && sessionKey !== ''
    // 拿不到会话 id 的请求（标题生成、摘要之类）也要占名额，否则它们能绕过并发上限。
    // 它们没有天然的释放者，所以用匿名 key：attach 时按"同一条路由、最老的那个"配对领走，
    // 万一流压根没启动，由 sweep 按 reserveTtlMs 回收。
    this.pending.set(named ? sessionKey : this._anonKey(), { route, at: this.now(), hitAt, anon: !named })
    return sessionKey
  }

  _anonKey() {
    return `~anon:${++this.anonSeq}`
  }

  /** 找"最老的"满足条件的占位（匿名请求没有会话 id 可对，只能按路由 + 最老来配对）。 */
  _oldestPending(predicate) {
    let best = null
    for (const [key, entry] of this.pending) {
      if (!predicate(key, entry)) continue
      if (best === null || entry.at < best.entry.at) best = { key, entry }
    }
    return best
  }

  _oldestAnon(route) {
    return this._oldestPending((_key, entry) => {
      if (!entry.anon) return false
      if (!route || typeof route.provider !== 'string') return true
      if (entry.route.provider !== route.provider) return false
      return typeof route.model !== 'string' || entry.route.model === route.model
    })
  }

  /**
   * 退还一次占位：请求在 prepareCall 阶段就挂了，名额和速率都不该算在头上。
   * 会审提的反例 —— 不撤销的话，一个配置写错的站会把自己的 rpm 配额空烧掉。
   */
  undoReservation(sessionKey, route) {
    let key = null
    if (typeof sessionKey === 'string' && sessionKey !== '') key = sessionKey
    else {
      const match = this._oldestAnon(route)
      key = match ? match.key : null
    }
    if (key === null) return
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    if (typeof entry.hitAt === 'number') this.undoHit(this._accountOf(entry.route.provider), entry.hitAt)
  }

  /** stream 开始时调用：把占位转成在飞。返回释放用的 key。 */
  attach(sessionKey, route) {
    let key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : null
    if (key === null) {
      // 匿名请求：领走同一条路由上最老的那个匿名占位，别让 reserve 占的那格漏成孤儿。
      const match = this._oldestAnon(route)
      key = match ? match.key : this._anonKey()
    }
    this.pending.delete(key)
    this.active.set(key, { route, at: this.now() })
    return key
  }

  /** 每来一个 chunk 刷新一次空闲计时（1 秒节流，避免每个 token 都写一次）。 */
  touch(key) {
    const entry = this.active.get(key)
    if (!entry) return
    const now = this.now()
    if (now - entry.at < 1_000) return
    entry.at = now
  }

  release(key) {
    this.active.delete(key)
    this.pending.delete(key)
  }

  /**
   * 记一次"这次尝试已经有结论了"（成功或失败都算），供 agent/request-error 去重。
   * 没有它的话，一次流内失败会被记两次：llm/stream 的 finish 帧一次、request-error 又一次，
   * 冷却时间凭空翻倍。
   */
  markSettled(sessionKey, provider) {
    this.settles.set(this._settleKey(sessionKey, provider), { at: this.now(), provider })
  }

  recentlySettled(sessionKey, provider) {
    const entry = this.settles.get(this._settleKey(sessionKey, provider))
    if (!entry) return false
    return this.now() - entry.at <= SETTLE_DEDUPE_MS
  }

  _settleKey(sessionKey, provider) {
    return typeof sessionKey === 'string' && sessionKey !== '' ? `s:${sessionKey}` : `p:${provider}`
  }

  _accountOf(provider) {
    const relays = this.configOf()?.relays
    const entry = relays instanceof Map ? relays.get(provider) : undefined
    return entry?.account ?? provider
  }

  /** 某个账号（可能是多个 provider id 共用一个上游账号）当前在飞的请求数。 */
  inflightOf(account) {
    let count = 0
    for (const { route } of this.pending.values()) if (this._accountOf(route.provider) === account) count += 1
    for (const { route } of this.active.values()) if (this._accountOf(route.provider) === account) count += 1
    return count
  }

  /** 整条路由上的在飞数（含其它 provider 共用同一账号的情况），给状态文件用。 */
  inflightOfProvider(provider) {
    return this.inflightOf(this._accountOf(provider))
  }

  // ── 速率闸门（每账号） ─────────────────────────────────────────────
  // 并发上限抓不住"密度"：12 路短请求大约每秒发 15 次，任何时刻在飞都不到上限，
  // 但 bree 实测 42.7% 返回 502 —— 打死它的是每秒多少次，不是同时几个。

  markHit(account) {
    const at = this.now()
    const list = this.hits.get(account)
    if (list) list.push(at)
    else this.hits.set(account, [at])
    this.lastHit.set(account, at)
    return at
  }

  /** 最近 60 秒内的请求次数（顺手丢弃过期时间戳，窗口外的不算）。 */
  hitsOf(account, windowMs = 60_000) {
    const list = this.hits.get(account)
    if (!list || list.length === 0) return 0
    const cutoff = this.now() - windowMs
    let drop = 0
    while (drop < list.length && list[drop] <= cutoff) drop += 1
    if (drop > 0) list.splice(0, drop)
    return list.length
  }

  /** 距这个账号上一次请求过去了多少毫秒；没发过就是 Infinity。 */
  sinceLastHit(account) {
    const last = this.lastHit.get(account)
    return last === undefined ? Infinity : this.now() - last
  }

  undoHit(account, at) {
    const list = this.hits.get(account)
    if (!list || list.length === 0) {
      this.lastHit.delete(account)
      return
    }
    const index = list.lastIndexOf(at)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) {
      this.hits.delete(account)
      this.lastHit.delete(account)
    } else {
      this.lastHit.set(account, list[list.length - 1])
    }
  }

  // ── 冷却 ──────────────────────────────────────────────────────────

  cooldownOf(provider) {
    const entry = this.cooldowns.get(provider)
    if (!entry) return null
    if (entry.until <= this.now()) {
      this.cooldowns.delete(provider)
      return null
    }
    return entry
  }

  /**
   * 记一次失败。code 只用于日志/状态展示，不参与逻辑 —— 因为中转站的错误码不统一，
   * 把所有失败都当成「这个站现在不可靠」比按错误码白名单判断更稳。
   */
  markFailure(provider, code, { baseMs, factor, maxMs } = {}) {
    if (typeof provider !== 'string' || provider === '') return
    const config = this.configOf() ?? {}
    const base = Number.isFinite(baseMs) ? baseMs : (config.cooldownBaseMs ?? 60_000)
    const growth = Number.isFinite(factor) ? factor : (config.cooldownFactor ?? 2)
    const cap = Number.isFinite(maxMs) ? maxMs : (config.cooldownMaxMs ?? 300_000)
    const previous = this.cooldowns.get(provider)
    const fails = (previous?.fails ?? 0) + 1
    const wait = Math.min(cap, base * Math.pow(growth, fails - 1))
    this.cooldowns.set(provider, { until: this.now() + wait, fails, code: String(code ?? 'UNKNOWN'), at: this.now() })
    this.stats.failures += 1
    return { fails, wait }
  }

  markSuccess(provider) {
    if (this.cooldowns.delete(provider)) this.stats.cooldownHits += 1
  }

  // ── 会话粘性 ──────────────────────────────────────────────────────

  sessionRoute(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey === '') return null
    const entry = this.sessions.get(sessionKey)
    if (!entry) return null
    const ttl = this.configOf()?.sessionTtlMs ?? 6 * 3600_000
    if (this.now() - entry.at > ttl) {
      this.sessions.delete(sessionKey)
      return null
    }
    // LRU：重新插入让它排到末尾
    this.sessions.delete(sessionKey)
    this.sessions.set(sessionKey, { ...entry, at: this.now() })
    return entry
  }

  remember(sessionKey, poolId, route) {
    if (typeof sessionKey !== 'string' || sessionKey === '') return
    const max = this.configOf()?.maxSessions ?? 500
    this.sessions.delete(sessionKey)
    this.sessions.set(sessionKey, { provider: route.provider, model: route.model, poolId, at: this.now() })
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) break
      this.sessions.delete(oldest.value)
    }
  }

  // ── 打散 ──────────────────────────────────────────────────────────

  lastPickedAt(route) {
    return this.lastPicked.get(`${route.provider}/${route.model}`) ?? 0
  }

  notePicked(route) {
    const key = `${route.provider}/${route.model}`
    this.lastPicked.delete(key)
    this.lastPicked.set(key, this.now())
    const max = 200
    while (this.lastPicked.size > max) {
      const oldest = this.lastPicked.keys().next()
      if (oldest.done) break
      this.lastPicked.delete(oldest.value)
    }
  }

  // ── 清理 ──────────────────────────────────────────────────────────

  sweep() {
    const now = this.now()
    const config = this.configOf() ?? {}
    const reserveTtl = config.reserveTtlMs ?? 120_000
    for (const [key, entry] of this.pending) if (now - entry.at > reserveTtl) this.pending.delete(key)
    for (const [key, entry] of this.active) if (now - entry.at > ACTIVE_IDLE_MS) this.active.delete(key)
    for (const [provider, entry] of this.cooldowns) if (entry.until <= now) this.cooldowns.delete(provider)
    const sessionTtl = config.sessionTtlMs ?? 6 * 3600_000
    for (const [key, entry] of this.sessions) if (now - entry.at > sessionTtl) this.sessions.delete(key)
    for (const [key, entry] of this.settles) if (now - entry.at > 60_000) this.settles.delete(key)
    // 速率窗口只需最近 60 秒：sweep 时顺手把过期的清掉，免得长时间运行后数组无限长。
    for (const account of [...this.hits.keys()]) if (this.hitsOf(account) === 0) this.hits.delete(account)
    this.stats.sweeps += 1
  }

  // ── 快照（状态文件用） ────────────────────────────────────────────

  snapshot() {
    const now = this.now()
    return {
      inflight: [...this.pending.values()].length + this.active.size,
      pending: this.pending.size,
      active: this.active.size,
      sessions: this.sessions.size,
      cooldowns: [...this.cooldowns.entries()].map(([provider, entry]) => ({
        provider,
        remainingMs: Math.max(0, entry.until - now),
        fails: entry.fails,
        code: entry.code,
      })),
      stats: { ...this.stats },
    }
  }
}
