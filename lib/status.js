/**
 * 可观测性：一份日志、一份状态快照。
 *
 * 为什么要落文件而不是只写 ctx.logger：DSH 的 host 日志在桌面端不一定看得到，
 * 而"插件到底有没有在选站"必须能事后查。日志 2MB 轮转，状态文件原子写（tmp + rename），
 * 外部脚本（或我自己在终端里）随时能 cat 到当前并发。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_LOG_BYTES = 2_000_000

function ensureDir(file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // 目录已存在，或没权限 —— 后面的写入自己会失败，这里不必抛
  }
}

function rotate(file) {
  try {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    // 文件不存在（第一次写）或轮转失败都不影响继续写
  }
}

/**
 * @param {{file: string, logger?: {info?: Function, warn?: Function}, echo?: boolean}} options
 * @returns {{log: (msg: string) => void, warn: (msg: string) => void, file: string}}
 */
export function createReporter({ file, logger, echo = false }) {
  ensureDir(file)
  const write = (tag, message) => {
    const line = `${new Date().toISOString()} ${tag} ${message}`
    rotate(file)
    try {
      appendFileSync(file, `${line}\n`)
    } catch {
      // 落盘失败不该影响路由
    }
    try {
      if (tag === 'WARN') logger?.warn?.(`[relay-pool] ${message}`)
      else logger?.info?.(`[relay-pool] ${message}`)
    } catch {
      // logger 坏掉也不影响
    }
    if (echo) console.log(line)
  }
  return {
    file,
    log: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
  }
}

/**
 * 状态快照写入器：1 秒最多写一次（每次请求都写盘太浪费），原子替换避免读到半个 JSON。
 * @param {{file: string, build: () => object, intervalMs?: number}} options
 */
export function createStatusWriter({ file, build, intervalMs = 1000 }) {
  ensureDir(file)
  let timer = null
  let lastWrite = 0

  const flush = () => {
    lastWrite = Date.now()
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(build(), null, 2)}\n`)
      renameSync(tmp, file)
    } catch {
      // 状态写不出去不影响路由
    }
  }

  const schedule = () => {
    if (timer) return
    const wait = Math.max(0, lastWrite + intervalMs - Date.now())
    timer = setTimeout(() => {
      timer = null
      flush()
    }, wait)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return { schedule, flush, file }
}
