import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertSongResult } from './match.js'

export const audioHash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export function songCacheKey({ scope, track, sourceHash, voice, converter, pitch, settings }) {
  const fingerprint = path => { try { const s = statSync(path); return [path, s.size, s.mtimeMs] } catch { return path || null } }
  return createHash('sha256').update(JSON.stringify(['song-v4', scope, track, sourceHash || null,
    voice ? [voice.id, fingerprint(voice.pth), fingerprint(voice.index)] : null, converter, pitch,
    settings.maxVoiceSec, settings.clipStart, settings.separatorModel, settings.vocalVolume, settings.instVolume])).digest('hex').slice(0, 32)
}
export function readSongCache(file, intent, expectedTrack) {
  if (intent.correctsJobId || !existsSync(file)) return null
  try {
    const meta = JSON.parse(readFileSync(file + '.json', 'utf8'))
    if (meta.version !== 1 || !statSync(file).size || meta.sha256 !== audioHash(file) || JSON.stringify(meta.track) !== JSON.stringify(expectedTrack)) return null
    const match = assertSongResult(meta, intent)
    return { file, ...meta, match, cacheHit: true }
  } catch { return null }
}
export function writeSongCache(file, source, metadata, intent) {
  const result = { ...metadata, version: 1, sha256: audioHash(source) }
  result.match = assertSongResult(result, intent)
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(source, file)
  writeFileSync(file + '.json', JSON.stringify(result), 'utf8')
  return { ...result, file, cacheHit: false }
}
