// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件所有数据都放这儿：~/.dsh/plugins-data/aurabot/ */
export function dataDir(...parts) {
  const base = process.env.AURABOT_DATA_DIR || join(dshHome(), 'plugins-data', 'aurabot')
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

/** 区分“文件不存在”和“文件存在但读不了/不是 JSON”：配置加载必须能报出后者。 */
export function readJsonStrict(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return { value: JSON.parse(text), error: null }
  } catch (error) {
    return { value: typeof fallback === 'function' ? fallback() : fallback, error }
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  // 配置文件含 API key / Cookie / webui 密码，默认 0600，避免同机其他用户读取。
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

export { existsSync }
