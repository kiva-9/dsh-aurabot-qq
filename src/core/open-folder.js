import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

export function openFolder(dir, { spawnImpl = spawn, platform = process.platform } = {}) {
  mkdirSync(dir, { recursive: true })
  const opener = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise(resolve => {
    let child
    try { child = spawnImpl(opener, [dir], { detached: true, windowsHide: true, stdio: 'ignore' }) }
    catch (error) { resolve({ ok: false, message: '打不开文件夹：' + error.message }); return }
    child.once('error', error => resolve({ ok: false, message: '打不开文件夹：' + error.message }))
    child.once('spawn', () => { child.unref(); resolve({ ok: true, message: '打开了' }) })
  })
}
