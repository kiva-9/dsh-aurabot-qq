// Metadata checks, not an assertion that the audio has been listened to.
export const MATCH_VERSION = 1
const key = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const names = value => Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : v?.name).filter(Boolean) : String(value || '').split(/\s*(?:\/|;|、| feat\.? | ft\.? )\s*/i).filter(Boolean)
const artistKeys = value => [...new Set([String(value || ''), ...names(value)].map(key).filter(Boolean))]

export function trackInfo(value = {}) {
  const raw = value.track || value
  // Legacy completed jobs stored only "song - artist". Never substitute the request.
  const legacy = !raw.name && typeof raw.title === 'string' ? raw.title.match(/^(.*?)\s+-\s+(.+)$/) : null
  const name = String(raw.name || legacy?.[1] || '').trim()
  const artists = names(raw.artists || raw.artist || legacy?.[2]).join(' / ')
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : raw.alias ? [raw.alias] : []).filter(s => typeof s === 'string' && s.trim()).slice(0, 20)
  return { id: raw.id == null ? null : String(raw.id), name, artists, title: name ? name + (artists ? ` - ${artists}` : '') : null, ...(aliases.length ? { aliases } : {}) }
}

export function matchTrack(candidate, intent = {}) {
  const actual = trackInfo(candidate), query = String(intent.track || intent.query || '').trim()
  const requested = { query: String(intent.query || ''), track: intent.track || null, artist: intent.artist || null, songId: intent.songId == null ? null : String(intent.songId) }
  const result = (status, reason) => ({ version: MATCH_VERSION, status, basis: 'catalog_metadata', requested, actual, reason })
  if (!actual.name || !actual.artists) return result('unverified', '缺少实际曲目或歌手元数据')
  if (requested.songId && actual.id !== requested.songId) return result('mismatch', '歌曲 ID 不一致')
  const titles = [actual.name, ...(actual.aliases || [])].map(key), artists = artistKeys(actual.artists)
  if (intent.artist && !artistKeys(intent.artist).every(a => artists.includes(a))) return result('mismatch', '歌手不一致')
  // Only whole title + whole artist combinations are accepted. Extra words are
  // constraints, not noise: "Wanted Dead or Alive 2Pac" cannot match Bon Jovi.
  const matches = text => { const q = key(text); return titles.some(title => q === title || artists.some(a => [title + a, a + title, a + '的' + title, title + 'by' + a].includes(q))) }
  if ((query && !matches(query)) || (intent.query && !matches(intent.query))) return result('mismatch', '歌名或请求中的歌手不一致')
  if (!query && !requested.songId) return result('unverified', '缺少可核验的歌名或歌曲 ID')
  return { ...result('matched', '已核对曲库歌名和歌手；未试听音频'), artistSpecified: Boolean(intent.artist) ||
    Boolean(intent.query && !titles.includes(key(intent.query))) }
}

export function songMatchError(match, candidates = []) {
  return Object.assign(new Error(`未确认请求的歌曲：${match.reason}；不会发送不匹配的作品${match.actual?.title ? `（实际候选：${match.actual.title}）` : ''}`), {
    code: 'SONG_MATCH_FAILED', kind: 'invalid', billing: 'none', match: { version: MATCH_VERSION, basis: 'catalog_metadata', ...match },
    candidates: candidates.slice(0, 8).map(trackInfo),
  })
}

export function assertSongResult(output, intent) {
  const match = intent.file ? { version: MATCH_VERSION, status: 'provided_file', basis: 'user_selected_file', actual: trackInfo(output), reason: '用户指定音频文件，未核验原曲身份' } : matchTrack(output, intent)
  if (!['matched', 'provided_file'].includes(match.status)) throw songMatchError(match)
  if ((intent.rejectedResults || []).some(r => (r.sha256 && r.sha256 === output.sha256) || (r.trackId && r.trackId === match.actual.id))) {
    throw Object.assign(songMatchError({ ...match, status: 'rejected', reason: '该音频或曲目已被本次纠错否定' }), { code: 'SONG_RESULT_REJECTED' })
  }
  return match
}

export function convertedFile(result, output, intent) {
  if (result?.track || result?.title) assertSongResult(result, intent)
  return typeof result === 'string' ? result : result?.file || result?.output || output
}
