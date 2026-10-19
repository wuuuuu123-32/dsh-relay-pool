/**
 * 两个钩子，没有别的。
 *
 * 1) agent/request —— 每一次模型请求前决定"这次走哪个站"。只在同一个 pool 内换，
 *    换的是通道不是能力档，所以不会把用户的模型选择改弱。
 * 2) llm/stream —— 唯一能精确知道"现在有几个请求在飞"的位置（每次重试都会再走一次），
 *    顺便从 finish 帧里读成功/失败，给冷却提供依据。
 *
 * 失败记在两处，但同一次失败只记一次：
 *   - llm/stream 的 finish 帧（流内失败、超时、429 都从这里出）
 *   - agent/request-error（补 prepareCall 阶段就挂掉的：凭据缺失、模型不存在）
 * 两路用一个 5 秒的去重窗口合并，否则同一次 RATE_LIMIT 会被记两遍、冷却时间翻倍。
 */
import { poolFor, routeId, selectRoute } from './select.js'

const EFFORT_CACHE_MS = 5 * 60_000

function sessionKeyOf(payload) {
  const id = payload?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : null
}

export function installHooks(ctx, deps) {
  const { ledger, configLoader, reporter, status, resolveModelInfo } = deps
  /** @type {Map<string, {ids: string[], modalities: string[], at: number}>} */
  const effortCache = new Map()

  async function modelCapabilities(provider, model, signal) {
    const key = `${provider}/${model}`
    const cached = effortCache.get(key)
    if (cached && Date.now() - cached.at < EFFORT_CACHE_MS) return cached
    const info = await resolveModelInfo(provider, model, signal)
    const ids = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
    const record = { ids, modalities: info?.inputModalities ?? ['text'], at: Date.now() }
    effortCache.set(key, record)
    return record
  }

  /**
   * 把 incoming 的 provider/model 换成 target。
   * 唯一需要处理的字段是 reasoningEffort：切到一个不支持该强度的站会被上游直接拒
   * （LlmError UNSUPPORTED_REASONING_EFFORT）。能支持就保留 —— 不能因为换站把质量降下来。
   * @returns {Promise<object|null>} null = 探测失败，调用方应放弃切换
   */
  async function retarget(incoming, target, signal) {
    const effort = typeof incoming?.reasoningEffort === 'string' ? incoming.reasoningEffort : undefined
    let base = incoming
    const switching = target.provider !== incoming.provider || target.model !== incoming.model
    if (effort !== undefined && switching) {
      let record
      try {
        record = await modelCapabilities(target.provider, target.model, signal)
      } catch (error) {
        reporter.warn(`探测 ${target.provider}/${target.model} 能力失败，本轮不切换：${error?.message ?? error}`)
        return null
      }
      if (!record.ids.includes(effort)) {
        const { reasoningEffort: _dropped, ...rest } = incoming
        base = rest
        reporter.log(`目标 ${target.provider}/${target.model} 不支持 reasoningEffort=${effort}，已按适配器默认值发送`)
      }
    }
    return { ...base, provider: target.provider, model: target.model }
  }

  async function decide(incoming, payload) {
    const { config } = configLoader()
    if (!config.enabled || config.pools.length === 0) return incoming

    const current = { provider: incoming?.provider, model: incoming?.model }
    if (typeof current.provider !== 'string' || typeof current.model !== 'string') return incoming

    const pool = poolFor(config, current)
    if (pool === null) return incoming // 不在任何池里：不是插件该管的请求

    const sessionKey = sessionKeyOf(payload)
    const decision = selectRoute({ pool, config, ledger, sessionKey, current })
    const skipText = decision.skipped.length > 0 ? ` | 跳过：${decision.skipped.join('；')}` : ''

    if (decision.route === null) {
      reporter.warn(`[${pool.id}] ${decision.reason}${skipText}`)
      status.schedule()
      return incoming
    }

    const same = decision.route.provider === current.provider && decision.route.model === current.model
    if (config.dryRun) {
      reporter.log(`[dry-run][${pool.id}] ${same ? '保持' : `拟切到 ${routeId(decision.route)}（原 ${routeId(current)}）`} —— ${decision.reason}${skipText}`)
      status.schedule()
      return incoming
    }

    if (same) {
      // 每个会话只记第一条"保持"。不这么收敛的话，一次对话几十上百发就是几百行，
      // 日志会被刷爆；但一条都不记又会让日志看着像从没生效（只有切换才有记录）。
      const known = ledger.sessionRoute(sessionKey)
      ledger.reserve(sessionKey, decision.route)
      ledger.remember(sessionKey, pool.id, decision.route)
      ledger.notePicked(decision.route)
      if (known === null) reporter.log(`[${pool.id}] 保持 ${routeId(decision.route)}：${decision.reason}`)
      status.schedule()
      return incoming
    }

    const nextConfig = await retarget(incoming, decision.route, payload?.signal)
    if (nextConfig === null) {
      ledger.reserve(sessionKey, current)
      status.schedule()
      return incoming
    }

    ledger.reserve(sessionKey, decision.route)
    ledger.remember(sessionKey, pool.id, decision.route)
    ledger.notePicked(decision.route)
    ledger.stats.switches += 1
    reporter.log(`[${pool.id}] ${routeId(current)} → ${routeId(decision.route)}：${decision.reason}${skipText}`)
    status.schedule()
    return nextConfig
  }

  ctx.on('agent/request', async (payload, next) => {
    const incoming = await next()
    try {
      return await decide(incoming, payload)
    } catch (error) {
      // 兜底：判定逻辑自己出问题，绝不能连累请求
      reporter.warn(`判定异常，按原配置放行：${error?.message ?? error}`)
      return incoming
    }
  })

  ctx.on('llm/stream', (options, next) => {
    const { config } = configLoader()
    if (!config.enabled) return next()

    const sessionKey = typeof options?.sessionId === 'string' ? options.sessionId : null
    const route = { provider: String(options?.provider ?? ''), model: String(options?.model ?? '') }

    // 注意：计数发生在生成器体内。消费者拿到生成器却不 next() 的极端情况下，
    // 这里不会 +1，也就不会留下一个永远减不掉的计数。
    return (async function* () {
      const key = ledger.attach(sessionKey, route)
      let settled = false
      const settle = (kind, failure) => {
        if (settled) return
        settled = true
        if (kind === 'aborted') return
        ledger.markSettled(sessionKey, route.provider)
        if (kind === 'error') {
          const info = ledger.markFailure(route.provider, failure?.code)
          if (info) reporter.warn(`失败 ${routeId(route)} → 冷却 ${Math.round(info.wait / 1000)}s（第 ${info.fails} 次，${failure?.code ?? 'UNKNOWN'}）`)
        } else {
          ledger.markSuccess(route.provider)
        }
      }
      try {
        for await (const chunk of next()) {
          ledger.touch(key)
          if (chunk?.type === 'finish') {
            const reason = chunk.reason
            if (reason?.kind === 'error') settle('error', reason.failure)
            else if (reason?.kind === 'aborted') settle('aborted')
            else settle('ok')
          }
          yield chunk
        }
        settle('aborted') // 没见到 finish 就结束了：不算成功也不算失败
      } catch (error) {
        settle('error', { code: error?.code ?? 'THROWN' })
        throw error
      } finally {
        ledger.release(key)
        status.schedule()
      }
    })()
  })

  /**
   * 第三只耳朵：`agent/request-error`。
   *
   * 它专门补 llm/stream 覆盖不到的失败 —— prepareCall 阶段就挂掉的（凭据缺失、
   * 模型不存在、适配器绑不上），这些根本没走到流，所以 finish 帧不会出现。
   * 不收这一路的话，一个配置写错的站会永远"看起来健康"，一直被选中、一直失败。
   *
   * 去重：流内失败时，finish 帧先记一次，紧接着 request-error 也会来，靠
   * recentlySettled（5 秒窗口）跳过第二次，否则冷却时间会翻倍。
   * 另外顺手释放这次尝试留下的占位 —— 请求没发出去，名额不该继续算在头上。
   */
  ctx.on('agent/request-error', async (payload, next) => {
    const action = await next()
    try {
      const { config } = configLoader()
      if (config.enabled) {
        const sessionKey = sessionKeyOf(payload)
        const provider = payload?.provider
        // 只退"还没变成在飞"的占位：已经进过流的失败，名额在流的 finally 里释放过了；
        // 退占位的同时把这次速率记账也撤掉 —— 请求压根没发出去，不该占配额。
        ledger.undoReservation(sessionKey, { provider, model: payload?.model })
        if (typeof provider === 'string' && provider !== '' && !ledger.recentlySettled(sessionKey, provider)) {
          const code = payload?.failure?.code ?? 'PREPARE'
          const info = ledger.markFailure(provider, code)
          if (info) reporter.warn(`请求前失败 ${provider} → 冷却 ${Math.round(info.wait / 1000)}s（第 ${info.fails} 次，${code}）`)
          status.schedule()
        }
      }
    } catch (error) {
      // 记账出问题绝不能影响重试决策
      reporter.warn(`request-error 记账异常（已忽略）：${error?.message ?? error}`)
    }
    return action
  })
}
