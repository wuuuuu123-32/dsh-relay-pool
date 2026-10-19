/**
 * 配置：读 `~/.dsh/relay-pool.json`，按 mtime 热重载（改配置不用重启 DSH），
 * 解析失败保留上一份好配置 —— 路由插件绝不能因为手滑写错 JSON 就把整个会话搞挂。
 *
 * 归一化只做三件事：补默认值、丢掉不成立的条目、把问题记进 issues 让调用方打日志。
 * 不做"猜"：没写 cost 就用默认 1，没写 concurrency 就用默认 4，不推断站与站的关系。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** relays 条目的合法字段。多写一个（多半是拼错）会让那道闸门静默失效，所以要报出来。 */
const RELAY_KEYS = new Set(['cost', 'concurrency', 'account', 'rpm', 'minGapMs'])

export const DEFAULTS = {
  enabled: true,
  dryRun: false,
  // 冷却：某站失败后多久再试。连续失败按倍数退避，封顶 cooldownMaxMs。
  cooldownBaseMs: 60_000,
  cooldownFactor: 2,
  cooldownMaxMs: 300_000,
  // 粘性：同一个会话优先留在上一次的站上（换站会让该站侧的前缀缓存全失效）。
  stickiness: true,
  stickinessMaxRank: 1, // 0=只有最便宜的能粘；1=最便宜或第二便宜
  // 原地可用就不换站。这是最省事也最省的默认：每次请求的 provider/model 来自配置
  // （主会话 zxcbug、子代理 bree），不是上一次请求改过的那个 ——
  // 所以"保留原地"等于"谁起始在哪儿就留在哪儿"，只有原地扛不住时才切换到同池的备用站。
  preferCurrent: true,
  // 会话表（粘性状态）不可能无限长：6 小时过期、最多 500 条。
  sessionTtlMs: 6 * 3600_000,
  maxSessions: 500,
  // 一次选择预留的并发名额，超过这个时间还没等到真正请求就释放（防泄漏）。
  reserveTtlMs: 120_000,
  defaultConcurrency: 4,
  defaultCost: 1,
  // 速率闸门（默认关）：rpm = 最近 60 秒内最多发几次；minGapMs = 两次请求的最小间隔。
  // 为什么在并发之外还要这两个：实测 bree 12 路短请求（约每秒 15 个）42.7% 返回 502，
  // 而任何时刻在飞可能都不到并发上限 —— 打死它的是"密度"，不是"同时几个"。
  defaultRpm: 0, // 0 = 不限
  defaultMinGapMs: 0,
}

export function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.length > 0 ? env : join(homedir(), '.dsh')
}

export function configFilePath() {
  return join(dshHome(), 'relay-pool.json')
}

/** 宽松布尔：只有显式 false 才算关。 */
function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function numOf(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把用户写的 JSON 归一化成运行时结构。
 * @returns {{config: object, issues: string[]}} issues 是"我丢掉了什么、为什么"，给日志用
 */
export function normalizeConfig(raw) {
  const issues = []
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && source !== raw) issues.push('配置文件顶层必须是对象，已忽略')

  const config = {
    enabled: boolOf(source.enabled, DEFAULTS.enabled),
    dryRun: boolOf(source.dryRun, DEFAULTS.dryRun),
    cooldownBaseMs: numOf(source.cooldownBaseMs, DEFAULTS.cooldownBaseMs, { min: 1_000 }),
    cooldownFactor: numOf(source.cooldownFactor, DEFAULTS.cooldownFactor, { min: 1, max: 10 }),
    cooldownMaxMs: numOf(source.cooldownMaxMs, DEFAULTS.cooldownMaxMs, { min: 5_000 }),
    stickiness: boolOf(source.stickiness, DEFAULTS.stickiness),
    preferCurrent: boolOf(source.preferCurrent, DEFAULTS.preferCurrent),
    stickinessMaxRank: numOf(source.stickinessMaxRank, DEFAULTS.stickinessMaxRank, { min: 0, max: 8 }),
    sessionTtlMs: numOf(source.sessionTtlMs, DEFAULTS.sessionTtlMs, { min: 60_000 }),
    maxSessions: numOf(source.maxSessions, DEFAULTS.maxSessions, { min: 16, max: 10_000 }),
    reserveTtlMs: numOf(source.reserveTtlMs, DEFAULTS.reserveTtlMs, { min: 10_000 }),
    defaultConcurrency: numOf(source.defaultConcurrency, DEFAULTS.defaultConcurrency, { min: 1, max: 512 }),
    defaultCost: numOf(source.defaultCost, DEFAULTS.defaultCost, { min: 0 }),
    relays: new Map(),
    pools: [],
  }
  if (config.cooldownMaxMs < config.cooldownBaseMs) {
    config.cooldownMaxMs = config.cooldownBaseMs
    issues.push('cooldownMaxMs 小于 cooldownBaseMs，已按 base 处理')
  }

  // ── relays：provider id → { cost, concurrency, account }
  const rawRelays = source.relays
  if (rawRelays !== undefined) {
    if (!rawRelays || typeof rawRelays !== 'object' || Array.isArray(rawRelays)) {
      issues.push('relays 必须是对象（key = provider id）')
    } else {
      for (const [rawId, entry] of Object.entries(rawRelays)) {
        const id = textOf(rawId)
        if (id === '') { issues.push('relays 里有空 key，已跳过'); continue }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          issues.push(`relays["${id}"] 必须是对象，已跳过`)
          continue
        }
        // 拼错的字段名是最阴的一类错：`rpmx: 20` 不会报错，只是这道闸门从来没生效过。
        for (const key of Object.keys(entry)) {
          if (!RELAY_KEYS.has(key)) {
            issues.push(`relays["${id}"] 有不认识的字段 "${key}"，已忽略（拼错会让这项设置静默失效）`)
          }
        }
        config.relays.set(id, {
          cost: numOf(entry.cost, DEFAULTS.defaultCost, { min: 0 }),
          concurrency: Math.round(numOf(entry.concurrency, DEFAULTS.defaultConcurrency, { min: 1, max: 512 })),
          // 0 / 负数 / 写错 → 当作不限（Infinity），不当作"禁止使用"
          rpm: numOf(entry.rpm, 0, { min: 0 }) || Infinity,
          minGapMs: Math.round(numOf(entry.minGapMs, 0, { min: 0, max: 600_000 })),
          account: textOf(entry.account) || id,
        })
      }
    }
  }

  // ── pools：能力池，池内路由被视为"质量等价"，可互相替换
  const rawPools = source.pools
  if (rawPools !== undefined) {
    if (!Array.isArray(rawPools)) {
      issues.push('pools 必须是数组')
    } else {
      const seenPoolIds = new Set()
      rawPools.forEach((pool, index) => {
        if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
          issues.push(`pools[${index}] 必须是对象，已跳过`)
          return
        }
        const id = textOf(pool.id) || `pool-${index + 1}`
        if (seenPoolIds.has(id)) { issues.push(`pool id "${id}" 重复，已跳过后一个`); return }
        const label = textOf(pool.label) || id
        const routes = []
        const seenRoutes = new Set()
        const rawRoutes = Array.isArray(pool.routes) ? pool.routes : []
        if (!Array.isArray(pool.routes)) issues.push(`pool "${id}" 的 routes 必须是数组`)
        rawRoutes.forEach((route, routeIndex) => {
          if (!route || typeof route !== 'object' || Array.isArray(route)) {
            issues.push(`pool "${id}" routes[${routeIndex}] 必须是对象，已跳过`)
            return
          }
          const provider = textOf(route.provider)
          const model = textOf(route.model)
          if (provider === '' || model === '') {
            issues.push(`pool "${id}" routes[${routeIndex}] 缺少 provider 或 model，已跳过`)
            return
          }
          const key = `${provider}/${model}`
          if (seenRoutes.has(key)) return
          seenRoutes.add(key)
          routes.push({ provider, model })
        })
        if (routes.length === 0) { issues.push(`pool "${id}" 没有有效路由，已跳过`); return }
        seenPoolIds.add(id)
        config.pools.push({ id, label, routes })
      })
    }
  }

  if (config.pools.length === 0) {
    // 不是错误：没配池子时插件保持沉默，什么都不改。只有一条提示。
    issues.push('没有配置任何 pools —— 插件不会改动任何请求（这不是错误）')
  }
  return { config, issues }
}

/**
 * 配置加载器：每次调用比对 mtime，变了才重读。
 * @param {{log: (msg: string) => void, path?: string}} options
 */
export function createConfigLoader({ log, path = configFilePath() }) {
  let state = { mtimeMs: -1, missing: true, config: normalizeConfig({}).config, issues: [] }
  let announcedMissing = false

  return function currentConfig() {
    let stat
    try {
      stat = statSync(path)
    } catch {
      if (state.missing && !announcedMissing) {
        announcedMissing = true
        log(`没有配置文件 ${path}（插件保持沉默，不干预任何请求）`)
      }
      state = { ...state, missing: true, mtimeMs: -1 }
      return state
    }
    announcedMissing = false
    if (stat.mtimeMs === state.mtimeMs && !state.missing) return state
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      // 保留上一份好配置：写坏一个逗号不该让路由失效。
      log(`配置解析失败，继续沿用上一份：${error?.message ?? error}`)
      state = { ...state, missing: false, mtimeMs: stat.mtimeMs }
      return state
    }
    const { config, issues } = normalizeConfig(parsed)
    state = { mtimeMs: stat.mtimeMs, missing: false, config, issues }
    for (const issue of issues) log(`配置：${issue}`)
    return state
  }
}
