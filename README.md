# dsh-relay-pool

并发感知的多中转站路由：**同一个能力档里，挑没满、没挂、最便宜的那个站。**

它做的事只有两件：

1. 每次模型请求前（`agent/request`），在当前模型所属的「池」里挑一条路由；
2. 包住每一个模型流（`llm/stream`），精确统计在飞请求数，并按成功/失败维护冷却。

它**不做**的事（这些是设计边界，不是没做完）：

- 不跨池换模型。换池就是换能力档，那是你的选择，插件不替你降级。
- 不按「任务大小」自动选模型。想省钱请把便宜模型设成默认，把贵的留在池外备用。
- 不碰任何你没写进 `pools` 的模型。没配池子时它完全沉默。

---

## 1. 装

```bash
# 1) 克隆到任意位置，下面用 <repo> 代表那个绝对路径（写正斜杠，如 D:/tools/dsh-relay-pool）
git clone <repo-url> <repo>

# 2) 链接进 desktop profile（改源码即时生效，重启 DSH 后加载）
dsh plugin --profile desktop add link:<repo>

# 3) 写配置（Windows 用 copy）
cp <repo>/config.example.json ~/.dsh/relay-pool.json

# 4) 重启 DSH（Host 侧代码改动必须重启才生效）
```

> ⚠️ `dsh plugin add` 在 DSH **运行中**可能报 `ERR_PNPM_EPERM`（`@dsh-ops/fastctx` 的 exe 被进程锁住）。
> 那时 `package.json` 和 lock 往往已经写好，只差 node_modules 里的链接 —— 手工补一个 Junction 即可：
> `New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-relay-pool" -Target '<repo>'`

重启后确认加载：

```powershell
Get-Content "$env:USERPROFILE\.dsh\relay-pool\route.log" -Tail 5
# 期望看到：启动 v0.1.0 | 配置 ... | 1 个池 / 2 条路由 / 2 个站 | enabled=True dryRun=False
```

> 没看到这行 = 插件没被加载。先查 `~/.dsh/profiles/desktop/package.json` 的 `bundles` 里有没有
> `dsh-relay-pool`，再查 `~/.dsh/profiles/desktop/cordis.patch.yml` 有没有 `- insert:` 那条
> （**裸 `- id:` 会被当成覆盖已有条目，静默无效**）。
>
> **顺序**：`bundles` 里把 `dsh-relay-pool` 放在 `dsh-vision-router` **之后**。
> 后加载 = 更内层的监听器，视觉路由先跑、最后由它拍板 —— 图片该走能看图的模型，
> 这个优先级必须高于"省钱"。

---

## 2. 真实用法：主会话留在 zxcbug，子代理优先走 bree

池子里要**至少两条路由**才有得选。本机的实际接法：

```
主会话   zxcbug / deepseek-v4.1-flash        ← 起始就在这条，靠粘性留住
子代理   bree   / deepseek-v4.1-flash-1017   ← 便宜 45%；满了或冷却了自动回落 zxcbug
```

**为什么不做「主会话豁免」开关**：`agent/request` 的 payload 里没有「我是不是子代理」
这种字段（`dsh-session` 的 README 原话是「fork 之外没有会话树」），能用的判据只有
`provider+model` 组合。所以反过来做，靠 `preferCurrent`（默认开）：

每一次请求的 `provider/model` 都来自配置 —— 主会话是 `zxcbug`、子代理是 `bree` ——
**不是上一次请求被改过的那个**。于是「原地可用就不换站」等价于「谁起始在哪儿就留在哪儿」：
主会话永远留在 zxcbug（它冷却/满载才会被切走，而它 `concurrency: 12`、`rpm: 0` 基本不会），
子代理永远留在 bree；bree 吃满 8 路或触发 `rpm` 时，这一发才回落到 zxcbug，下一发又回 bree。

子代理那条路由靠 DSH 自带的「插件 → 子智能体 → 模型选择」（`subagent-model-selection`）指定，
父代理派活时从白名单里挑。**注意**：bree 目前只在 `~/.dsh/profiles/headless/cordis.patch.yml`
里注册过；桌面端要用它，得把那份 `providers.bree` 整块（`apiKeyEnv: BREE_API_KEY`、
`baseURL: https://new.breeai.top/v1`、模型 `deepseek-v4.1-flash-1017`）也加进
`~/.dsh/profiles/desktop/cordis.patch.yml`，否则那条路由会被当作"适配器不存在"跳过。

**选择的优先级（顺序固定，不要指望它自己猜）**：

```
preferCurrent（原地还健康就留）  →  stickiness（会话上次的站）  →  成本升序  →  负载比  →  最久没被选
```

`preferCurrent` 排在粘性之前，是因为它作用在**这一次请求的起始配置**上，比"上次选的站"更接近
用户显式写下的意图；粘性只在"原地已经不可用"时才起作用（比如 bree 满了，把这一发拉回**本会话
上次的**站，而不是全局最便宜的那个），作用是保住该站侧的前缀缓存。

**代价说清楚**：`preferCurrent` 默认开，意味着只要原地那个站健康就**不会**为了省钱跳站 ——
贵站健康就一直用贵的。这正是"主会话留 zxcbug"要的效果；要让成本绝对优先（谁便宜用谁、
不管起始在哪），把它设成 `false`。

切到「全走便宜的」时顺手做一件事：把贵站的 `concurrency` 抬高（比如 zxcbug 12 → 16）。
那时它只剩兜底用途 —— bree 满了或冷却了才轮到它，平时一次都不会被摸到，
抬高不会增加平时压力，但能接住 bree 塌掉那一刻的全部流量。

配置（`~/.dsh/relay-pool.json`，完整例子见 `config.example.json`）：

```json
{
  "enabled": true,
  "relays": {
    "zxcbug": { "cost": 100, "concurrency": 12, "rpm": 0 },
    "bree": { "cost": 55, "concurrency": 8, "rpm": 20, "minGapMs": 200 }
  },
  "pools": [
    {
      "id": "flash",
      "routes": [
        { "provider": "bree", "model": "deepseek-v4.1-flash-1017" },
        { "provider": "zxcbug", "model": "deepseek-v4.1-flash" }
      ]
    }
  ],
  "preferCurrent": true,
  "stickiness": true,
  "stickinessMaxRank": 1
}
```

三个参数的理由：

- `cost` 100 / 55 —— 只是相对权重，表达「bree 比 zxcbug 便宜 45%」。
- bree `concurrency: 8` —— 12 路实测 42.7% 返回 502；4 到 8 路只是延迟从 3.5s 涨到 4s 左右，可以接受。
- bree `rpm: 20` / `minGapMs: 200` —— 并发闸门抓不住"密度"：12 路短请求崩的时候，
  任何时刻在飞可能都不到 4 个。这两个字段管的是「每分钟发几次」和「两次之间隔多久」。

> `model` 必须写成**该 provider 在 `llm-pi-ai` 里声明的那个 id**。
> 两个站的模型名不一样也没关系 —— 池子按 `provider+model` 匹配，不同名也能归进同一个池。

---

## 3. 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时两个钩子都直接放行 |
| `dryRun` | `false` | 只写日志、不改请求。第一次配新站建议先开一天看日志 |
| `relays.<provider>.cost` | `1` | 相对成本权重，不用换算真实单价 |
| `relays.<provider>.concurrency` | `4` | 该上游账号允许同时跑几个请求 |
| `relays.<provider>.rpm` | `0`（不限） | 最近 60 秒内最多发几次请求。并发抓不住"密度"，密集短请求靠它拦 |
| `relays.<provider>.minGapMs` | `0`（不限） | 两次请求之间的最小间隔，挡住"刚发完又立刻发" |
| `relays.<provider>.account` | provider id | 多个 provider 共用一个上游账号时，填同一个名字共享并发额度 |
| `pools[].routes[]` | — | `{ provider, model }`，同一池内被视为能力等价 |
| `preferCurrent` | `true` | 原地可用就不换站。关掉它才会「永远选最便宜的」 |
| `stickiness` | `true` | 同一会话优先留在上次的站（换站会让该站侧前缀缓存失效） |
| `stickinessMaxRank` | `1` | 允许粘住的成本排名上限。`0`=只有最便宜的能粘，`1`=最便宜或第二便宜 |
| `cooldownBaseMs` | `60000` | 第一次失败后的冷却时长 |
| `cooldownFactor` | `2` | 连续失败按倍数退避 |
| `cooldownMaxMs` | `300000` | 冷却上限 |
| `reserveTtlMs` | `120000` | 预留名额多久没兑现就回收（防泄漏） |
| `sessionTtlMs` / `maxSessions` | 6h / 500 | 粘性状态什么时候过期、最多记多少会话 |

改完**不用重启**：每次请求都对比文件 mtime，改了立刻生效。
JSON 写错也不会炸 —— 解析失败时继续用上一份好配置，并在日志里记一行。

---

## 4. 看它现在在干什么

```powershell
type "$env:USERPROFILE\.dsh\relay-pool\status.json"
```

关键字段：

- `inflight` / `pending` / `active`：现在有几个请求在飞（pending = 已选站但请求还没发出）
- `pools[].routes[].inflight`：每条路由的实际负载
- `pools[].routes[].coolingMs`：还剩多少毫秒解除冷却
- `pools[].routes[].hits60s`：最近 60 秒这条路由发了几次（对着配置里的 `rpm` 就知道还剩多少配额）
- `cooldowns[]`：哪些站在冷却、第几次失败、错误码
- `stats.switches`：总共换了多少次站
- `available`：DSH 当前认得的 provider 和模型（用来核对配置里写的 model id 对不对）

日志一行一次决策：

```
2026-10-19T02:41:03.120Z INFO  [flash] cheap-relay/m → zxcbug/m：最便宜可用（cost=0.4，在飞 0/2，负载比 0.00） | 跳过：zxcbug/m 成本排名 1 超过阈值 0，改走更便宜的
2026-10-19T02:41:19.881Z WARN  失败 cheap-relay/m → 冷却 60s（第 1 次，RATE_LIMIT）
```

---

## 5. 已知限制

- **只统计同一进程内的请求**。headless 任务（`blender_rt_headless` 之类另起进程的）不计入。
- **不检测模型能力差异**。池内是否"质量等价"由你保证；插件只处理一个客观差异：
  目标站不支持当前的 `reasoningEffort` 时会把该字段去掉（否则上游直接拒）。
- **冷却按 provider 记**，因为中转站的 429/5xx 基本都是账号级问题，按模型记太细反而慢半拍。
- **粘性只在成本排名阈值内生效**。如果一个站突然变便宜，老会话不会为了几毛钱立刻跳站 ——
  这是有意的：跳一次站，整个上下文的前缀缓存白算。
- **并发超限时不排队**。全部路由都满载时会挑负载最小的那个继续压，而不是让回合卡住等名额。
  想硬限流请把 `concurrency` 调小、并把池子做成"够用的容量"。
- **速率闸门在"整池都超"时是软的**。所有路由的 `rpm` 都用完、并发也满了，插件仍会挑
  「没超速率」的那个硬发一次 —— 宁可多一次 502 也不让回合卡死。要绝对不越界，
  就把池子里的另一条路由配成能承接的容量（例如 zxcbug 不设 `rpm`）。
- **兜底那条要留容量**。bree 的 `rpm` 用满后，流量会整体倾向 zxcbug；zxcbug 的 `concurrency`
  再满，下一个请求就走「整池满载」分支硬发。所以 zxcbug 配 `rpm: 0`（靠 `concurrency: 12` 收口），
  想再加一层保护就调它的 `concurrency`，不要给它设 `rpm`。
- **拿不到 sessionId 的请求没有豁免**（标题生成、摘要之类）：它们同样占并发名额、记速率，
  只是没有天然的释放者 —— 流启动时按「同一条路由、最老的那个」配对领走，没配上的 120 秒后由 sweep 回收。

---

## 6. 排障

| 现象 | 先看 |
|---|---|
| 请求完全没被改 | `route.log` 有没有 `启动` 那行；配置里的 `model` 是否与 `available` 里的 id 逐字相同 |
| 一直在两个站之间来回跳 | `stickiness` 是否被关；`stickinessMaxRank` 是否设成 0 且两站价格差很多 |
| 某个站从来没被选过 | 它是不是一直在冷却（看 `cooldowns`）；或成本排名太靠后 |
| 并发数看着不对 | `pending` 长期不为 0 = 选完站但请求没发出，`reserveTtlMs` 到点会回收 |
| 想先观察不改动 | `"dryRun": true` |

---

## 7. 开发

```bash
node test/select.test.js   # 选站逻辑（纯函数）
node test/hooks.test.js    # 两个钩子：计数、冷却、粘性、fail-open
node test/smoke.test.js    # 装进 host 的冒烟：落文件、注册钩子、真改 provider
```

> 别用 `node --test test/`：它按文件起子进程，在当前沙箱下会 `spawn EPERM`。
