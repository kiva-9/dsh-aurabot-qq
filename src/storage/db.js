// SQLite 主库：事实、任务、发送记录的唯一主存储（媒体文件放文件系统）。
// 用 Node 自带的 node:sqlite（DSH 运行时 Node 24 / Electron 44 里实测可用，含 FTS5），不需要原生依赖。
//
// 主线程用同步连接做小而快的事务（登记消息、领任务、写回执）；
// 大查询（向量扫描、重建索引）以后放进 worker，另开只读连接（WAL 模式允许并发读）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
]

/**
 * 打开数据库。file 为 ':memory:' 时只在内存里（测试用）。
 * 返回的对象只暴露项目里用到的几样：run / get / all / exec / tx / close。
 */
export function openDatabase(file, { readOnly = false } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const raw = new DatabaseSync(file, { readOnly })
  for (const p of PRAGMAS) {
    if (readOnly && /journal_mode|synchronous/.test(p)) continue
    raw.exec(p)
  }
  const cache = new Map()
  const stmt = (sql) => {
    let s = cache.get(sql)
    if (!s) {
      s = raw.prepare(sql)
      cache.set(sql, s)
      if (cache.size > 256) cache.delete(cache.keys().next().value)
    }
    return s
  }
  let depth = 0
  let savepoint = 0

  /**
   * 事务：fn 正常返回就提交，抛错就回滚并把错误继续抛出。可以嵌套（内层用 SAVEPOINT）。
   * fn 必须是同步函数：事务中途 await 会让别的代码插进同一个连接。
   */
  function tx(fn) {
    if (fn?.constructor?.name === 'AsyncFunction') throw new Error('事务里不能用异步函数')
    if (depth > 0) {
      const name = `sp_${++savepoint}`
      raw.exec(`SAVEPOINT ${name}`)
      depth++
      try {
        const r = fn()
        if (r && typeof r.then === 'function') throw new Error('事务里不能用异步函数')
        raw.exec(`RELEASE ${name}`)
        return r
      } catch (error) {
        raw.exec(`ROLLBACK TO ${name}`)
        raw.exec(`RELEASE ${name}`)
        throw error
      } finally {
        depth--
      }
    }
    raw.exec('BEGIN IMMEDIATE')
    depth = 1
    try {
      const r = fn()
      if (r && typeof r.then === 'function') throw new Error('事务里不能用异步函数')
      raw.exec('COMMIT')
      return r
    } catch (error) {
      try { raw.exec('ROLLBACK') } catch (e) {}
      throw error
    } finally {
      depth = 0
    }
  }

  return {
    file,
    raw,
    run: (sql, ...params) => stmt(sql).run(...params),
    get: (sql, ...params) => stmt(sql).get(...params),
    all: (sql, ...params) => stmt(sql).all(...params),
    exec: (sql) => raw.exec(sql),
    tx,
    get inTransaction() { return depth > 0 },
    close() {
      cache.clear()
      try { raw.close() } catch (error) {}
    },
  }
}

/** JSON 列：存时序列化，读时容错（坏数据当 fallback）。 */
export const toJson = (v) => (v === undefined ? null : JSON.stringify(v))
export function fromJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback
  try { return JSON.parse(text) } catch (error) { return fallback }
}
