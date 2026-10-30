// 发文件的路径把关：只放行白名单目录里的普通文件。
// 必须先 realpath 再比较，否则目录里的符号链接能指到白名单外面。

import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'

export const FILE_BASE64_MAX = 30 * 1024 * 1024
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.dsh'])
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i

const reject = (message) => Object.assign(new Error(message), { code: 'FILE_REJECTED' })
const within = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
const real = (path) => { try { return realpathSync(path) } catch { return '' } }

/** 校验一个本机路径；过了返回 { path（真实路径）, size, name }，不过抛 FILE_REJECTED。 */
export function checkLocalFile(file, { roots, denied = [], maxBytes }) {
  if (!isAbsolute(file)) throw reject('要发本机文件得给绝对路径')
  const path = real(file)
  if (!path) throw reject('找不到这个文件')
  const parts = path.split(sep)
  if (SENSITIVE_FILE.test(parts.at(-1)) || parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase())) || denied.map(real).filter(Boolean).some((dir) => within(dir, path))) {
    throw reject('这个文件可能含密钥或配置，不能发')
  }
  if (!roots.map(real).filter(Boolean).some((root) => within(root, path))) throw reject('这个文件不在允许发送的目录里')
  const info = statSync(path)
  if (!info.isFile()) throw reject('这不是一个文件')
  if (info.size > maxBytes) throw reject(`文件太大（${(info.size / 1048576).toFixed(1)} MB），上限 ${Math.round(maxBytes / 1048576)} MB`)
  return { path, size: info.size, name: basename(path) }
}

/** 发到 QQ 上显示的文件名：去掉路径和控制字符。 */
export function displayName(name, fallback = '文件') {
  const clean = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 200)
  return clean || fallback
}
