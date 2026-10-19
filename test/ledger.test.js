import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { Ledger } from '../lib/ledger.js'

const CONFIG = normalizeConfig({
  relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 2 } },
}).config

function makeLedger(start = 1_800_000_000_000) {
  const clock = { now: start }
  const ledger = new Ledger({ now: () => clock.now, configOf: () => CONFIG })
  return { ledger, clock }
}

test('占位同时记一次速率', () => {
  const { ledger } = makeLedger()
  ledger.reserve('s1', { provider: 'cheap', model: 'm' })
  assert.equal(ledger.hitsOf('cheap'), 1)
  assert.equal(ledger.inflightOf('cheap'), 1)
})

test('没有会话 id 的请求：同样占名额、也记速率，attach 时按路由配对领走', () => {
  const { ledger } = makeLedger()
  const route = { provider: 'cheap', model: 'm' }
  ledger.reserve(null, route)
  assert.equal(ledger.hitsOf('cheap'), 1)
  assert.equal(ledger.inflightOf('cheap'), 1) // 不能让它绕过并发上限
  const key = ledger.attach(null, route)
  assert.equal(ledger.inflightOf('cheap'), 1) // 占位转在飞，不重复计
  assert.equal(ledger.pending.size, 0)
  ledger.release(key)
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('没有会话 id 的请求失败时，按路由把占位和速率一起退掉', () => {
  const { ledger } = makeLedger()
  const route = { provider: 'cheap', model: 'm' }
  ledger.reserve(null, route)
  ledger.undoReservation(null, route)
  assert.equal(ledger.hitsOf('cheap'), 0)
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('请求没发出去时退还占位，速率也一并撤回', () => {
  const { ledger } = makeLedger()
  ledger.reserve('s1', { provider: 'cheap', model: 'm' })
  ledger.undoReservation('s1')
  assert.equal(ledger.hitsOf('cheap'), 0)
  assert.equal(ledger.inflightOf('cheap'), 0)
})

test('已经进过流的请求：undo 是空操作，不会误删在飞名额', () => {
  const { ledger } = makeLedger()
  ledger.reserve('s1', { provider: 'cheap', model: 'm' })
  const key = ledger.attach('s1', { provider: 'cheap', model: 'm' })
  ledger.undoReservation('s1')
  assert.equal(ledger.inflightOf('cheap'), 1)
  ledger.release(key)
  assert.equal(ledger.inflightOf('cheap'), 0)
  // 流结束不撤速率：请求确实发出去过
  assert.equal(ledger.hitsOf('cheap'), 1)
})

test('速率窗口按 60 秒滚动', () => {
  const { ledger, clock } = makeLedger()
  ledger.reserve('s1', { provider: 'cheap', model: 'm' })
  clock.now += 61_000
  assert.equal(ledger.hitsOf('cheap'), 0)
  assert.equal(ledger.sinceLastHit('cheap'), 61_000)
  ledger.reserve('s2', { provider: 'cheap', model: 'm' })
  assert.equal(ledger.hitsOf('cheap'), 1)
})

test('没发过请求的账号：间隔算作无限大', () => {
  const { ledger } = makeLedger()
  assert.equal(ledger.sinceLastHit('pricey'), Infinity)
})

test('共用账号的多个 provider 共享同一份速率与并发', () => {
  const config = normalizeConfig({
    relays: { a: { concurrency: 2, account: 'same' }, b: { concurrency: 2, account: 'same' } },
  }).config
  const ledger = new Ledger({ now: () => 0, configOf: () => config })
  ledger.reserve('s1', { provider: 'a', model: 'm' })
  assert.equal(ledger.hitsOf('same'), 1)
  assert.equal(ledger.inflightOf('same'), 1)
  assert.equal(ledger.inflightOfProvider('b'), 1)
})

test('匿名占位只在同一条路由上配对，不会领走别的站的格子', () => {
  const { ledger } = makeLedger()
  ledger.reserve(null, { provider: 'pricey', model: 'm' })
  const key = ledger.attach(null, { provider: 'cheap', model: 'm' })
  // 没配对上 → 另开一格；pricey 那格仍在（会被 sweep 按 TTL 回收）
  assert.equal(ledger.inflightOf('cheap'), 1)
  assert.equal(ledger.inflightOf('pricey'), 1)
  ledger.release(key)
})

test('relays 里写错字段名要报出来（否则闸门静默失效）', () => {
  const { issues } = normalizeConfig({
    relays: { cheap: { cost: 1, concurrency: 2, rpmx: 20 } },
  })
  assert.ok(issues.some((line) => line.includes('rpmx')))
})

test('两个匿名请求乱序落地 / 乱序收尾：名额不漂，最后归零', () => {
  // 会审反例：A、B 同一路由先后占位，B 先落地领走 A 的占位，随后 A 失败"按最老"退还，
  // 可能把还在飞的 B 提前释放、放出超过 concurrency 的请求。
  const config = normalizeConfig({ relays: { a: { cost: 1, concurrency: 1 } }, pools: [] }).config
  const ledger = new Ledger({ configOf: () => config, now: () => 1_800_000_000_000 })
  const route = { provider: 'a', model: 'm' }

  ledger.reserve(null, route)
  ledger.reserve(null, route)
  assert.equal(ledger.inflightOfProvider('a'), 2, '占位也计入并发，否则同一 tick 的请求看不见彼此')

  const second = ledger.attach(null, route) // 后发的先落地
  const first = ledger.attach(null, route)
  assert.notEqual(first, second, '两次落地必须拿到不同的释放键')

  ledger.undoReservation(null, route) // 一发在落地前就失败了：已经没有占位可退
  assert.equal(ledger.inflightOfProvider('a'), 2, '退还只能作用于占位，不能把在飞的那格退掉')

  ledger.release(second)
  assert.equal(ledger.inflightOfProvider('a'), 1)
  ledger.release(first)
  assert.equal(ledger.inflightOfProvider('a'), 0, '全部收尾后必须归零')
})

test('一发已落地、一发落地前失败：退还的是剩下那个占位', () => {
  const config = normalizeConfig({ relays: { a: { cost: 1, concurrency: 2 } }, pools: [] }).config
  const ledger = new Ledger({ configOf: () => config, now: () => 1_800_000_000_000 })
  const route = { provider: 'a', model: 'm' }

  ledger.reserve(null, route)
  ledger.reserve(null, route)
  const key = ledger.attach(null, route)
  ledger.undoReservation(null, route)
  assert.equal(ledger.inflightOfProvider('a'), 1)
  ledger.release(key)
  assert.equal(ledger.inflightOfProvider('a'), 0)
})
