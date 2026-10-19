/**
 * dsh-relay-pool —— 并发感知的多中转站路由。
 *
 * 它解决的是这件事：同一个能力档（pool）里往往有好几条中转站通道，便宜的并发一高就 429，
 * 贵的一直稳。插件做两件事：
 *   · 每次模型请求前，在同池内挑「没冷却、没满载、最便宜」的那条；
 *   · 用 llm/stream 精确统计在飞请求，失败的站按退避冷却，成功的站立刻恢复。
 *
 * 设计边界（有意为之）：
 *   · 只在同一 pool 内换 —— 换池就是换模型能力，那是用户的选择，插件不替他降级；
 *   · 不在同一会话里为了省钱反复跳站 —— 换站会让该站侧的前缀缓存失效，跳一次亏一次；
 *   · 任何异常都 fail-open：判定失败就按用户原本的配置走，插件不该成为故障点。
 *
 * 产物（都在 $DSH_HOME/relay-pool/ 下）：
 *   route.log    每次选站/冷却一行，2MB 轮转
 *   status.json  当前池、在飞数、冷却、可用模型（原子写，1s 节流）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configFilePath, createConfigLoader, dshHome } from './lib/config.js'
import { installHooks } from './lib/hooks.js'
import { Ledger } from './lib/ledger.js'
import { routeId } from './lib/select.js'
import { createReporter, createStatusWriter } from './lib/status.js'

export const name = 'dsh-relay-pool'
export const inject = ['llm']

const HERE = dirname(fileURLToPath(import.meta.url))

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const SWEEP_MS = 15_000
const AVAILABLE_REFRESH_MS = 60_000

export function apply(ctx, cliConfig = {}) {
  const startedAt = Date.now()
  const stateDir = join(dshHome(), 'relay-pool')

  const reporter = createReporter({ file: join(stateDir, 'route.log'), logger: ctx.logger })
  const configLoader = createConfigLoader({ log: reporter.log })
  const ledger = new Ledger({ configOf: () => configLoader().config })

  /** @type {Record<string, string[]>} */
  let available = {}
  let availableAt = 0

  async function refreshAvailable() {
    const collected = {}
    try {
      const providers = typeof ctx.llm?.listProviders === 'function' ? ctx.llm.listProviders() : []
      for (const provider of providers) {
        const id = provider?.id
        if (typeof id !== 'string' || id === '') continue
        try {
          const registration = ctx.llm.registration(id)
          const models = await registration?.adapter?.listModels?.(id)
          collected[id] = Array.isArray(models) ? models.map((model) => model?.id).filter(Boolean) : []
        } catch {
          collected[id] = []
        }
      }
    } catch (error) {
      reporter.warn(`枚举可用模型失败：${error?.message ?? error}`)
    }
    available = collected
    availableAt = Date.now()
  }

  function buildStatus() {
    const { config } = configLoader()
    const snapshot = ledger.snapshot()
    const accounts = new Map()
    for (const relay of config.relays.values()) {
      accounts.set(relay.account, {
        account: relay.account,
        concurrency: relay.concurrency,
        rpm: Number.isFinite(relay.rpm) ? relay.rpm : null,
      })
    }
    return {
      at: new Date().toISOString(),
      pid: process.pid,
      version: VERSION,
      uptimeMs: Date.now() - startedAt,
      enabled: config.enabled,
      dryRun: config.dryRun,
      configPath: configFilePath(),
      logPath: reporter.file,
      pools: config.pools.map((pool) => ({
        id: pool.id,
        label: pool.label,
        routes: pool.routes.map((route) => {
          const relay = config.relays.get(route.provider)
          const account = relay?.account ?? route.provider
          const cooldown = ledger.cooldownOf(route.provider)
          return {
            id: routeId(route),
            provider: route.provider,
            model: route.model,
            cost: relay?.cost ?? config.defaultCost,
            account,
            concurrency: relay?.concurrency ?? config.defaultConcurrency,
            rpm: relay?.rpm && Number.isFinite(relay.rpm) ? relay.rpm : null,
            minGapMs: relay?.minGapMs ?? 0,
            hits60s: ledger.hitsOf(account),
            inflight: ledger.inflightOf(account),
            coolingMs: cooldown ? Math.max(0, cooldown.until - Date.now()) : 0,
          }
        }),
      })),
      accounts: [...accounts.values()].map((entry) => ({
        ...entry,
        inflight: ledger.inflightOf(entry.account),
        hits60s: ledger.hitsOf(entry.account),
      })),
      ...snapshot,
      available,
      availableAt: availableAt === 0 ? null : new Date(availableAt).toISOString(),
    }
  }

  const status = createStatusWriter({ file: join(stateDir, 'status.json'), build: buildStatus })

  installHooks(ctx, {
    ledger,
    configLoader,
    reporter,
    status,
    resolveModelInfo: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
  })

  // ── 自证：启动时把"我是谁、读到什么"写清楚，排障第一步就看这行 ──
  const { config } = configLoader()
  const routeCount = config.pools.reduce((sum, pool) => sum + pool.routes.length, 0)
  reporter.log(
    `启动 v${VERSION} | 配置 ${configFilePath()} | ${config.pools.length} 个池 / ${routeCount} 条路由 / ${config.relays.size} 个站` +
    ` | enabled=${config.enabled} dryRun=${config.dryRun} stickiness=${config.stickiness}`,
  )
  if (cliConfig !== null && typeof cliConfig === 'object' && Object.keys(cliConfig).length > 0) {
    reporter.log(`cordis 传入的配置（仅记录，以配置文件为准）：${JSON.stringify(cliConfig)}`)
  }
  status.flush()

  void refreshAvailable().then(() => status.schedule())

  const sweepTimer = setInterval(() => {
    ledger.sweep()
    if (Date.now() - availableAt > AVAILABLE_REFRESH_MS) void refreshAvailable()
    status.schedule()
  }, SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  const dispose = () => {
    clearInterval(sweepTimer)
    status.flush()
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
}
