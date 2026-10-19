import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { poolFor, routeId, selectRoute } from '../lib/select.js'

const NOW = 1_800_000_000_000

function makeLedger({ cooldowns = {}, inflight = {}, sessions = {}, picked = {}, hits = {}, gaps = {} } = {}) {
  return {
    cooldownOf(provider) {
      const until = cooldowns[provider]
      if (until === undefined || until <= NOW) return null
      return { until, fails: 1, code: 'RATE_LIMIT' }
    },
    inflightOf(account) {
      return inflight[account] ?? 0
    },
    hitsOf(account) {
      return hits[account] ?? 0
    },
    sinceLastHit(account) {
      return gaps[account] ?? Infinity
    },
    sessionRoute(key) {
      return sessions[key] ?? null
    },
    lastPickedAt(route) {
      return picked[routeId(route)] ?? 0
    },
  }
}

const CONFIG = normalizeConfig({
  relays: {
    cheap: { cost: 1, concurrency: 2 },
    pricey: { cost: 5, concurrency: 2 },
  },
  pools: [
    {
      id: 'flash',
      routes: [
        { provider: 'cheap', model: 'm' },
        { provider: 'pricey', model: 'm' },
      ],
    },
  ],
}).config

const POOL = CONFIG.pools[0]

test('空闲时选最便宜的', () => {
  const decision = selectRoute({ pool: POOL, config: CONFIG, ledger: makeLedger(), sessionKey: null, now: NOW })
  assert.equal(routeId(decision.route), 'cheap/m')
})

test('便宜的满载时退到贵的', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ inflight: { cheap: 2 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.skipped.some((line) => line.includes('满载')))
})

test('便宜的在冷却时退到贵的', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ cooldowns: { cheap: NOW + 30_000 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.skipped.some((line) => line.includes('冷却剩 30s')))
})

test('全部冷却时不动请求', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ cooldowns: { cheap: NOW + 30_000, pricey: NOW + 30_000 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(decision.route, null)
})

test('全部满载时取归一化负载最小的，而不是报错', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ inflight: { cheap: 2, pricey: 1 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
})

test('粘性：上次的站在阈值内就留着，不为了几毛钱跳站', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({
      sessions: { s1: { provider: 'pricey', model: 'm', poolId: 'flash', at: NOW } },
    }),
    sessionKey: 's1',
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.reason.includes('粘住'))
})

test('粘性阈值 0 时只粘最便宜的', () => {
  const config = normalizeConfig({
    ...JSON.parse(JSON.stringify({ relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 2 } }, pools: [{ id: 'flash', routes: [{ provider: 'cheap', model: 'm' }, { provider: 'pricey', model: 'm' }] }] })),
    stickinessMaxRank: 0,
  }).config
  const decision = selectRoute({
    pool: config.pools[0],
    config,
    ledger: makeLedger({ sessions: { s1: { provider: 'pricey', model: 'm', poolId: 'flash', at: NOW } } }),
    sessionKey: 's1',
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'cheap/m')
})

test('同价同负载时打散：最久没被选过的优先', () => {
  const config = normalizeConfig({
    relays: { a: { cost: 1, concurrency: 2 }, b: { cost: 1, concurrency: 2 } },
    pools: [{ id: 'p', routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }] }],
  }).config
  const decision = selectRoute({
    pool: config.pools[0],
    config,
    ledger: makeLedger({ picked: { 'a/m': NOW - 1000, 'b/m': NOW - 5000 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'b/m')
})

test('poolFor 只认完全相同的 provider+model', () => {
  assert.equal(poolFor(CONFIG, { provider: 'cheap', model: 'm' })?.id, 'flash')
  assert.equal(poolFor(CONFIG, { provider: 'cheap', model: 'other' }), null)
  assert.equal(poolFor(CONFIG, { provider: 'nope', model: 'm' }), null)
})

test('配置归一化：丢掉残缺条目并给出原因', () => {
  const { config, issues } = normalizeConfig({
    pools: [
      { id: 'a', routes: [{ provider: 'x' }, { provider: 'x', model: 'm' }, { provider: 'x', model: 'm' }] },
      { id: 'b', routes: [] },
      { id: 'a', routes: [{ provider: 'y', model: 'm' }] },
    ],
  })
  assert.equal(config.pools.length, 1)
  assert.deepEqual(config.pools[0].routes, [{ provider: 'x', model: 'm' }])
  assert.ok(issues.some((line) => line.includes('缺少 provider 或 model')))
  assert.ok(issues.some((line) => line.includes('没有有效路由')))
  assert.ok(issues.some((line) => line.includes('重复')))
})

// ── 速率闸门（rpm / minGapMs） ──────────────────────────────────────
// 并发上限抓不住密度：同一秒里 8 个短请求，在飞可能只有 2 个，但上游照样 502。

const RATE_CONFIG = normalizeConfig({
  relays: {
    cheap: { cost: 1, concurrency: 8, rpm: 3 },
    pricey: { cost: 5, concurrency: 8 },
  },
  pools: [{ id: 'p', routes: [{ provider: 'cheap', model: 'm' }, { provider: 'pricey', model: 'm' }] }],
}).config

test('rpm 满额时退到贵的（并发还没满也一样）', () => {
  const decision = selectRoute({
    pool: RATE_CONFIG.pools[0],
    config: RATE_CONFIG,
    ledger: makeLedger({ hits: { cheap: 3 }, inflight: { cheap: 0 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.skipped.some((line) => line.includes('速率已满')))
})

test('rpm 没满时仍然优先便宜的', () => {
  const decision = selectRoute({
    pool: RATE_CONFIG.pools[0],
    config: RATE_CONFIG,
    ledger: makeLedger({ hits: { cheap: 2 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'cheap/m')
})

test('minGapMs 挡住「刚发过又立刻发」', () => {
  const config = normalizeConfig({
    relays: {
      cheap: { cost: 1, concurrency: 8, minGapMs: 1500 },
      pricey: { cost: 5, concurrency: 8 },
    },
    pools: [{ id: 'p', routes: [{ provider: 'cheap', model: 'm' }, { provider: 'pricey', model: 'm' }] }],
  }).config
  const decision = selectRoute({
    pool: config.pools[0],
    config,
    ledger: makeLedger({ gaps: { cheap: 300 }, inflight: { cheap: 0 } }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.skipped.some((line) => line.includes('距上次请求')))
})

test('整池都超速率时仍放行，但先挑没超的那个', () => {
  const decision = selectRoute({
    pool: RATE_CONFIG.pools[0],
    config: RATE_CONFIG,
    ledger: makeLedger({
      // 两个都满载（并发闸门全部拦下），只有 pricey 的 rpm 还干净
      inflight: { cheap: 8, pricey: 8 },
      hits: { cheap: 99 },
    }),
    sessionKey: null,
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.reason.includes('全部满载'))
})

// ── preferCurrent：原地可用就不换站 ─────────────────────────────────
// 每次请求的 provider/model 都来自配置（主会话 zxcbug、子代理 bree），不是上次改过的那个。
// 所以"保留原地"= 谁起始在哪儿就留在哪儿，这是主会话不被搬到便宜站的关键。

test('原地可用就不换站（哪怕另一个站更便宜）', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger(),
    sessionKey: null,
    current: { provider: 'pricey', model: 'm' },
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'pricey/m')
  assert.ok(decision.reason.includes('不换站'))
})

test('原地满载了才换到同池的备用站', () => {
  const decision = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ inflight: { pricey: 2 } }),
    sessionKey: null,
    current: { provider: 'pricey', model: 'm' },
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'cheap/m')
})

test('原地在冷却时切走，冷却结束后再切回来', () => {
  const away = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger({ cooldowns: { pricey: NOW + 30_000 } }),
    sessionKey: null,
    current: { provider: 'pricey', model: 'm' },
    now: NOW,
  })
  assert.equal(routeId(away.route), 'cheap/m')

  const back = selectRoute({
    pool: POOL,
    config: CONFIG,
    ledger: makeLedger(),
    sessionKey: null,
    current: { provider: 'pricey', model: 'm' },
    now: NOW,
  })
  assert.equal(routeId(back.route), 'pricey/m')
})

test('preferCurrent 关掉后回到「最便宜优先」', () => {
  const config = normalizeConfig({
    preferCurrent: false,
    relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 2 } },
    pools: [{ id: 'p', routes: [{ provider: 'cheap', model: 'm' }, { provider: 'pricey', model: 'm' }] }],
  }).config
  const decision = selectRoute({
    pool: config.pools[0],
    config,
    ledger: makeLedger(),
    sessionKey: null,
    current: { provider: 'pricey', model: 'm' },
    now: NOW,
  })
  assert.equal(routeId(decision.route), 'cheap/m')
})
