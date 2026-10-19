/**
 * 冒烟测试：不是测逻辑，是测「装进 DSH 之后它真的会动」。
 *
 * 覆盖三件事，缺一件就说明这个插件在真实环境里可能根本不加载：
 *   1. 模块能被 import、apply 不抛异常；
 *   2. 日志与状态文件真的落在 $DSH_HOME/relay-pool/ 下（可观测性自证）；
 *   3. agent/request 监听器真的被注册，且走一遍能改掉 provider。
 *
 * 用临时 DSH_HOME，绝不碰用户真实的 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

function makeCtx() {
  const handlers = new Map()
  return {
    logger: { info() {}, warn() {} },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    handlers,
    llm: {
      listProviders: () => [{ id: 'cheap' }, { id: 'pricey' }],
      registration: () => ({ adapter: { listModels: async () => [{ id: 'm' }] } }),
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] }, inputModalities: ['text'] }),
    },
  }
}

test('装进 host 后：落文件、注册钩子、真的能改 provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-pool-smoke-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    writeFileSync(join(home, 'relay-pool.json'), JSON.stringify({
      relays: { cheap: { cost: 1, concurrency: 2 }, pricey: { cost: 5, concurrency: 1 } },
      pools: [{ id: 'flash', routes: [{ provider: 'pricey', model: 'm' }, { provider: 'cheap', model: 'm' }] }],
    }))

    const ctx = makeCtx()
    apply(ctx, {})

    // 1) 钩子注册齐全
    assert.equal(ctx.handlers.get('agent/request')?.length, 1)
    assert.equal(ctx.handlers.get('llm/stream')?.length, 1)

    // 2) 日志文件有"我是谁"的自证行
    const logPath = join(home, 'relay-pool', 'route.log')
    assert.ok(existsSync(logPath), '启动后必须留下 route.log')
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /启动 v\d+\.\d+\.\d+/)
    assert.match(log, /1 个池 \/ 2 条路由 \/ 2 个站/)

    // 3) 状态文件可解析且结构对
    const statusPath = join(home, 'relay-pool', 'status.json')
    assert.ok(existsSync(statusPath), '启动后必须写出 status.json')
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    assert.equal(status.enabled, true)
    assert.equal(status.pools.length, 1)
    assert.equal(status.pools[0].routes.length, 2)

    // 4) 真跑 agent/request：第一发生效于原地（pricey 还空着就不换站），
    //    第二发把 pricey 的唯一名额占掉之后，必须被改写到同池的 cheap。
    const handler = ctx.handlers.get('agent/request')[0]
    const first = await handler({ agent: { session: { id: 'smoke-1' } } }, async () => ({ provider: 'pricey', model: 'm' }))
    assert.equal(first.provider, 'pricey', '原地可用时不该换站')

    const second = await handler({ agent: { session: { id: 'smoke-2' } } }, async () => ({ provider: 'pricey', model: 'm' }))
    assert.equal(second.provider, 'cheap', '原地满了必须切到同池备用站')
    assert.equal(second.model, 'm')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
