import { trackInfo, matchTrack, songMatchError, assertSongResult } from './match.js'

// Resolve identity before checking availability. An unavailable requested artist
// never authorizes downloading a different artist's same-named song.
export async function selectSong(intent, { catalog, cookie, skip = [], check = () => {}, rank = list => list }) {
  const found = intent.songId ? [await catalog.songDetail(intent.songId, { cookie })]
    : await catalog.searchSongs([intent.track || intent.query, intent.artist].filter(Boolean).join(' '), { cookie, limit: 10 })
  check()
  if (!found.length) throw songMatchError({ status: 'unverified', reason: '当前查询没有返回候选，不能确认是否收录', actual: null })
  const matched = found.filter(s => matchTrack(s, intent).status === 'matched')
  if (!matched.length) throw songMatchError({ status: 'mismatch', reason: '当前候选没有同时满足歌名、歌手和歌曲 ID 的结果', actual: null }, found)
  if (!intent.songId && matched.every(s => !matchTrack(s, intent).artistSpecified) && new Set(matched.map(s => trackInfo(s).artists.toLowerCase())).size > 1) {
    throw songMatchError({ status: 'ambiguous', reason: '同名歌曲有多位歌手，请明确歌手后再点歌', actual: null }, matched)
  }
  const eligible = rank(matched, intent.query).filter(s => !skip.includes(String(s.id)) && !(intent.rejectedResults || []).some(r => r.trackId === String(s.id)))
  if (!eligible.length) throw songMatchError({ status: 'rejected', reason: '匹配候选已被纠错否定或确认没有人声', actual: null }, matched)
  for (const candidate of eligible) {
    const track = trackInfo(candidate)
    const match = assertSongResult({ track }, intent)
    const url = await catalog.songUrl(candidate.id, { cookie })
    check()
    if (url.url && !url.trial) return { track, match, url: url.url }
  }
  throw Object.assign(new Error('匹配的歌曲目前没有可用的完整音频（可能受会员或版权限制）；未改选其他歌手'), { kind: 'invalid', billing: 'none' })
}
