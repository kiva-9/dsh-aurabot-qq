// 旧数据迁移框架：预检报告 → 备份 → 按步骤导入，每步成功才推进，失败就停在那一步。
// 原始 JSON 文件不删不改；导入只往主库里写。已删除功能（QQ 空间、抖音）的数据只记进报告。
// 具体的导入步骤（人设、记忆、表情……）由各阶段登记到 steps 里。

import { existsSync, statSync, readdirSync, mkdirSync, copyFileSync, cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from '../core/store.js'

/** 旧版本会用到的数据文件。kind：json 文件 / dir 目录；removed：所属功能已删除。large：备份时跳过（太大或可重新生成）。 */
export const LEGACY_FILES = [
  { name: 'config.json', kind: 'json', what: '设置' },
  { name: 'sessions.json', kind: 'json', what: 'QQ 会话 ↔ DSH 会话对照' },
  { name: 'memories.json', kind: 'json', what: '记忆库', count: (j) => (Array.isArray(j?.items) ? j.items.length : 0) },
  { name: 'mood.json', kind: 'json', what: '心情' },
  { name: 'mutes.json', kind: 'json', what: '闭嘴状态' },
  { name: 'speakup.json', kind: 'json', what: '主动搭话' },
  { name: 'bili.json', kind: 'json', what: 'B 站' },
  { name: 'friend-requests.json', kind: 'json', what: '好友申请' },
  { name: 'personas', kind: 'dir', what: '人格' },
  { name: 'chatlog', kind: 'dir', what: '聊天流水' },
  { name: 'stickers', kind: 'dir', what: '表情库' },
  { name: 'modules', kind: 'dir', what: '自己写的扩展模块' },
  { name: 'modules-data', kind: 'dir', what: '扩展模块的数据' },
  { name: 'local', kind: 'dir', what: '本地接口脚本', large: true },
  { name: 'songs', kind: 'dir', what: '翻唱', large: true },
  { name: 'logs', kind: 'dir', what: '日志', large: true },
  { name: 'voice-cache', kind: 'dir', what: '语音缓存', large: true },
  { name: 'diary.json', kind: 'json', what: '空间日记（功能已删除）', removed: true },
  { name: 'qzone-social.json', kind: 'json', what: '空间互动（功能已删除）', removed: true },
  { name: 'douyin.json', kind: 'json', what: '抖音（功能已删除）', removed: true },
  { name: 'douyin', kind: 'dir', what: '抖音登录资料（功能已删除）', removed: true, large: true },
]

function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { files++; try { bytes += statSync(p).size } catch (error) {} }
    }
  }
  try { walk(dir) } catch (error) {}
  return { files, bytes }
}

/** 预检：看看数据目录里有哪些旧数据、各有多少，不改任何东西。 */
export function preflight(baseDir) {
  const items = []
  const warnings = []
  for (const f of LEGACY_FILES) {
    const p = join(baseDir, f.name)
    if (!existsSync(p)) continue
    const it = { name: f.name, what: f.what, kind: f.kind, removed: Boolean(f.removed), large: Boolean(f.large) }
    if (f.kind === 'json') {
      it.bytes = statSync(p).size
      const j = readJson(p, undefined)
      if (j === undefined) warnings.push(`${f.name} 读不出来（不是合法 JSON），导入时会跳过`)
      else if (f.count) it.items = f.count(j)
    } else {
      Object.assign(it, dirStats(p))
    }
    items.push(it)
  }
  const removed = items.filter((i) => i.removed)
  if (removed.length) warnings.push(`已删除功能留下的数据：${removed.map((i) => i.name).join('、')}。不会导入，也不会删除。`)
  return { at: Date.now(), baseDir, items, warnings }
}

/**
 * 备份旧数据（升级前）：JSON 文件和小目录原样复制到 _backup-v2-时间戳/，大目录只记在清单里。
 * 返回 { dir, copied, skipped }。
 */
export function backupLegacy(baseDir, report = preflight(baseDir), stamp = Date.now()) {
  const dir = join(baseDir, `_backup-v2-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const copied = []
  const skipped = []
  const failed = []
  for (const it of report.items) {
    const src = join(baseDir, it.name)
    if (it.large) { skipped.push(it.name); continue }
    try {
      if (it.kind === 'json') copyFileSync(src, join(dir, it.name))
      else cpSync(src, join(dir, it.name), { recursive: true })
      copied.push(it.name)
    } catch (error) {
      failed.push(`${it.name}（复制失败：${error.message}）`)
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ at: stamp, copied, skipped, failed, complete: !failed.length, report }, null, 2), 'utf8')
  if (failed.length) throw new Error(`升级备份不完整，停止迁移：${failed.join('；')}。备份清单：${dir}`)
  return { dir, copied, skipped }
}

/**
 * 按顺序跑导入步骤。step = { id, run({ baseDir, storage, log }) → report }。
 * 做完的步骤跳过；某一步失败就停下，返回 { ok: false, blockedAt }，后面的步骤不跑，
 * 调用方据此不让新实现去读半迁移的数据。
 */
export async function runLegacySteps({ storage, steps, baseDir, log }) {
  const done = []
  for (const step of steps) {
    const prev = storage.legacy.get(step.id)
    if (prev?.state === 'done') continue
    storage.legacy.start(step.id)
    try {
      const report = await step.run({ baseDir, storage, log })
      storage.legacy.finish(step.id, report)
      done.push(step.id)
      log?.info?.(`旧数据导入：${step.id} 完成`)
    } catch (error) {
      storage.legacy.fail(step.id, error.message)
      log?.warn?.(`旧数据导入：${step.id} 失败，后面的步骤先不跑：`, error.message)
      return { ok: false, done, blockedAt: step.id, error: error.message }
    }
  }
  return { ok: true, done, blockedAt: null }
}
