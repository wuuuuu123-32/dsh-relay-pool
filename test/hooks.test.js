import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { installHooks } from '../lib/hooks.js'
import { Ledger } from '../lib/ledger.js'

const START = 1_800_000_000_000

/** 极简 ctx：只实现 waterfall / stream 的监听与串联，顺序与 cordis 一致（先注册的在最外层）。 */
function makeCtx(llm) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    llm,
    terminal: () => (async function* () {})(),
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    async waterfall(event, payload, seed) {
      const list = handlers.get(event) ?? []
      let index = -1
      const next = () => {
        index += 1
        if (index >= list.length) return seed ? seed() : undefined
        return list[index](payload, next)
      }
      return await next()
    },
    stream(event, options) {
      const list = handlers.get(event) ?? []
      let index = -1
      const next = () => {
        index += 1
        if (index >= list.length) return ctx.terminal()
        return list[index](options, next)
      }
      return next()
    },
  }
  return ctx
}

function setup({ relays, pools, overrides, resolveModelInfo } = {}) {
  const config = normalizeConfig({ relays, pools, ...overrides }).config
  const logs = []
  const ctx = makeCtx({
    resolveModelInfo: resolveModelInfo ?? (async () => ({ reasoning: { efforts: [{ id: 'high' }] }, inputModalities: ['text'] })),
  })
  let clock = START
  const ledger = new Ledger({ now: () => clock, configOf: () => config })
  installHooks(ctx, {
    ledger,
    configLoader: () => ({ config }),
    reporter: { log: (msg) => logs.push(`INFO ${msg}`), warn: (msg) => logs.push(`WARN ${msg}`) },
    status: { schedule() {}, flush() {} },
    resolveModelInfo: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
  })
  return { ctx, config, ledger, logs, advance: (ms) => { clock += ms } }
}

const TWO_STATIONS = {
  relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 2 } },
  pools: [
    {
      id: 'flash',
      routes: [
        { provider: 'pricey', model: 'm' },
        { provider: 'cheap', model: 'm' },
      ],
    },
  ],
}

async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('原地可用就不换站：贵站也留着（不为了几毛钱跳站）', async () => {
  const { ctx } = setup(TWO_STATIONS)
  const incoming = { provider: 'pricey', model: 'm' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out.provider, 'pricey')
})

test('原地扛不住时才切到同池更便宜的站', async () => {
  const { ctx, ledger } = setup({
    relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 1 } },
    pools: TWO_STATIONS.pools,
  })
  // 先把贵站占满（并发上限 1）
  ledger.reserve('other', { provider: 'pricey', model: 'm' })
  const incoming = { provider: 'pricey', model: 'm' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out.provider, 'cheap')
  assert.equal(out.model, 'm')
})

test('不在池里的模型完全不碰', async () => {
  const { ctx } = setup(TWO_STATIONS)
  const incoming = { provider: 'other', model: 'x' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out, incoming)
})

test('选择时先占位：并发的第二个请求会被挤到另一个站', async () => {
  // 便宜站并发上限 1，第二个请求就必须退到贵站
  const { ctx, ledger } = setup({
    relays: { cheap: { cost: 1, concurrency: 1 }, pricey: { cost: 5, concurrency: 2 } },
    pools: TWO_STATIONS.pools,
  })
  const seed = () => ({ provider: 'cheap', model: 'm' })
  const first = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, seed)
  assert.equal(first.provider, 'cheap')
  assert.equal(ledger.inflightOf('cheap'), 1)
  const second = await ctx.waterfall('agent/request', { agent: { session: { id: 's2' } } }, seed)
  assert.equal(second.provider, 'pricey')
})

test('stream 结束（成功）后归还名额', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => ({ provider: 'cheap', model: 'm' }))
  assert.equal(ledger.inflightOf('cheap'), 1)
  ctx.terminal = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' }))
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('失败只记一次，并给该站上冷却', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  ctx.terminal = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
  })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' }))
  const cooldown = ledger.cooldownOf('cheap')
  assert.ok(cooldown)
  assert.equal(cooldown.fails, 1, '同一次失败只能记一次')
  assert.equal(cooldown.code, 'RATE_LIMIT')
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('失败的站进入冷却后，下一次请求自动避开它', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  ctx.terminal = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }
  })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' }))
  assert.ok(ledger.cooldownOf('cheap'))
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's2' } } }, () => ({ provider: 'cheap', model: 'm' }))
  assert.equal(out.provider, 'pricey')
})

test('成功一次就把冷却清掉', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  ctx.terminal = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
  })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' }))
  assert.ok(ledger.cooldownOf('cheap'))
  ctx.terminal = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's2' }))
  assert.equal(ledger.cooldownOf('cheap'), null)
})

test('消费端提前退出也不会漏计数', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => ({ provider: 'cheap', model: 'm' }))
  ctx.terminal = () => (async function* () {
    yield { type: 'start' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const iterator = ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' })
  await iterator.next()
  await iterator.return()
  assert.equal(ledger.inflightOf('cheap'), 0)
  assert.equal(ledger.cooldownOf('cheap'), null)
})

test('生成器从未被消费时不计数（占位由 sweep 兜底清理）', async () => {
  const { ctx, ledger, advance } = setup(TWO_STATIONS)
  await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => ({ provider: 'cheap', model: 'm' }))
  assert.equal(ledger.inflightOf('cheap'), 1, '此时只有预留名额')
  ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' })
  assert.equal(ledger.inflightOf('cheap'), 1, '没启动生成器，仍是 1')
  advance(200_000)
  ledger.sweep()
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('目标站不支持该 reasoningEffort 时丢掉这个字段，而不是让上游拒掉', async () => {
  const { ctx } = setup({
    ...TWO_STATIONS,
    overrides: { preferCurrent: false },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] }, inputModalities: ['text'] }),
  })
  const incoming = { provider: 'pricey', model: 'm', reasoningEffort: 'high' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out.provider, 'cheap')
  assert.equal('reasoningEffort' in out, false)
})

test('目标站支持该 reasoningEffort 时保留字段（不因换站降质量）', async () => {
  const { ctx } = setup({ ...TWO_STATIONS, overrides: { preferCurrent: false } })
  const incoming = { provider: 'pricey', model: 'm', reasoningEffort: 'high' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out.provider, 'cheap')
  assert.equal(out.reasoningEffort, 'high')
})

test('能力探测失败时按原配置走（fail-open）', async () => {
  const { ctx } = setup({
    ...TWO_STATIONS,
    resolveModelInfo: async () => {
      throw new Error('UNKNOWN_MODEL')
    },
  })
  const incoming = { provider: 'pricey', model: 'm', reasoningEffort: 'high' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out, incoming)
})

test('dryRun 只记日志，不改请求', async () => {
  const { ctx, logs } = setup({ ...TWO_STATIONS, overrides: { dryRun: true } })
  const incoming = { provider: 'pricey', model: 'm' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out, incoming)
  assert.ok(logs.some((line) => line.includes('dry-run')))
})

test('没有配置任何池时保持沉默', async () => {
  const { ctx, logs } = setup({ relays: {}, pools: [] })
  const incoming = { provider: 'any', model: 'thing' }
  const out = await ctx.waterfall('agent/request', {}, () => incoming)
  assert.equal(out, incoming)
  assert.equal(logs.length, 0)
})

test('请求前就失败的站（没走到流）也会冷却，并释放占位', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => ({ provider: 'cheap', model: 'm' }))
  assert.equal(ledger.inflightOf('cheap'), 1)

  const action = await ctx.waterfall('agent/request-error', {
    agent: { session: { id: 's1' } },
    provider: 'cheap',
    failure: { code: 'MISSING_CREDENTIAL' },
  })
  assert.equal(action, undefined, '不能把重试决策吃掉')
  assert.equal(ledger.inflightOf('cheap'), 0, '请求没发出去，名额要还')
  assert.equal(ledger.cooldownOf('cheap')?.code, 'MISSING_CREDENTIAL')
})

test('流内失败之后紧跟的 request-error 不会重复记账', async () => {
  const { ctx, ledger } = setup(TWO_STATIONS)
  ctx.terminal = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
  })()
  await drain(ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' }))
  assert.equal(ledger.cooldownOf('cheap')?.fails, 1)

  await ctx.waterfall('agent/request-error', {
    agent: { session: { id: 's1' } },
    provider: 'cheap',
    failure: { code: 'RATE_LIMIT' },
  })
  assert.equal(ledger.cooldownOf('cheap')?.fails, 1, '同一次失败只能记一次')
})

test('同一 provider 换 model 时也要探测 reasoningEffort', async () => {
  const { ctx } = setup({
    overrides: { preferCurrent: false },
    relays: { only: { cost: 1, concurrency: 4 } },
    pools: [{ id: 'p', routes: [{ provider: 'only', model: 'a' }, { provider: 'only', model: 'b' }] }],
    resolveModelInfo: async (_provider, model) => ({
      reasoning: { efforts: model === 'a' ? [{ id: 'low' }] : [{ id: 'high' }] },
      inputModalities: ['text'],
    }),
  })
  const incoming = { provider: 'only', model: 'b', reasoningEffort: 'high' }
  const out = await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => incoming)
  assert.equal(out.model, 'a')
  assert.equal('reasoningEffort' in out, false)
})

test('已启动但被遗弃的生成器：空闲超时后被回收，不会永久占着名额', async () => {
  const { ctx, ledger, advance } = setup(TWO_STATIONS)
  await ctx.waterfall('agent/request', { agent: { session: { id: 's1' } } }, () => ({ provider: 'cheap', model: 'm' }))
  ctx.terminal = () => (async function* () {
    yield { type: 'start' }
    yield { type: 'start' }
  })()
  const iterator = ctx.stream('llm/stream', { provider: 'cheap', model: 'm', sessionId: 's1' })
  await iterator.next() // 启动后就不管它了（既不 next 也不 return）
  assert.equal(ledger.inflightOf('cheap'), 1)
  advance(130_000)
  ledger.sweep()
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('同一会话只记一条"保持"，第二次不再刷屏', async () => {
  const { ctx, logs } = setup(TWO_STATIONS)
  const incoming = { provider: 'pricey', model: 'm' }
  const payload = { agent: { session: { id: 's-keep' } } }
  await ctx.waterfall('agent/request', payload, () => incoming)
  await ctx.waterfall('agent/request', payload, () => incoming)
  const kept = logs.filter((line) => line.includes('保持 pricey/m'))
  assert.equal(kept.length, 1, '一次会话只该留下一条保持记录')
  assert.match(kept[0], /原地/)
})
