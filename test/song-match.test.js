import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchTrack, trackInfo, assertSongResult, convertedFile } from '../src/song/match.js'
import { selectSong } from '../src/song/selection.js'
import { songCacheKey, readSongCache, writeSongCache, audioHash } from '../src/song/cache.js'

const wanted = { query: 'Wanted Dead or Alive 2Pac' }
const wrong = { id: 1, name: 'Wanted Dead or Alive', artists: 'Bon Jovi' }
const right = { id: 2, name: 'Wanted Dead or Alive', artists: '2Pac / Snoop Dogg' }
const catalog = (list, url = () => ({ url: 'fixture://audio', trial: false })) => ({
  searchSongs: async () => list, songDetail: async id => list.find(s => String(s.id) === String(id)), songUrl: async id => url(id),
})

test('同名不同歌手拒绝；旧关键词、前后歌手、显式字段与大小写标点可匹配', () => {
  for (const query of ['Wanted Dead or Alive 2Pac', '2Pac 的《Wanted Dead or Alive》', 'Wanted Dead or Alive by 2pac']) {
    assert.equal(matchTrack(wrong, { query }).status, 'mismatch')
    assert.equal(matchTrack(right, { query }).status, 'matched')
  }
  assert.equal(matchTrack(right, { query: 'Wanted Dead or Alive', track: 'Wanted Dead or Alive', artist: '2Pac' }).status, 'matched')
  assert.equal(matchTrack(wrong, { query: wanted.query, track: wrong.name, artist: 'Bon Jovi' }).status, 'mismatch', '显式字段不能掩盖原请求冲突')
  assert.equal(matchTrack({ ...right, name: 'Wanted Dead or Alive (Live)' }, wanted).status, 'mismatch')
  assert.equal(matchTrack(right, { query: 'Wanted Dead', artist: '2Pac' }).status, 'mismatch')
  assert.equal(matchTrack({ name: 'Wanted Dead or Alive' }, wanted).status, 'unverified')
  assert.deepEqual(trackInfo({ title: 'Wanted Dead or Alive - Bon Jovi' }), { ...wrong, id: null, title: 'Wanted Dead or Alive - Bon Jovi' })
})

test('曲库明确提供的译名可匹配，实际标题仍保留原名；无歌手的同名歧义不擅自选', async () => {
  const song = { id: 3, name: '初音ミクの消失', artists: '初音ミク / cosMo@暴走P', aliases: ['初音未来的消失'] }
  const result = await selectSong({ query: '初音未来的消失' }, { catalog: catalog([song]) })
  assert.equal(result.track.title, '初音ミクの消失 - 初音ミク / cosMo@暴走P')
  assert.equal(matchTrack({ ...song, aliases: [] }, { query: '初音未来的消失' }).status, 'mismatch')
  await assert.rejects(selectSong({ query: 'Wanted Dead or Alive' }, { catalog: catalog([wrong, right], () => assert.fail('歧义不能下载')) }), /同名歌曲有多位歌手/)
})

test('旧换声脚本路径、file/output对象和仅写输出的返回值仍兼容；声明换曲的脚本拒绝', () => {
  for (const value of ['old.wav', { file: 'old.wav' }, { output: 'old.wav' }]) assert.equal(convertedFile(value, 'fallback.wav', wanted), 'old.wav')
  assert.equal(convertedFile(undefined, 'fallback.wav', wanted), 'fallback.wav')
  assert.equal(convertedFile({ file: 'new.wav', track: right }, 'fallback.wav', wanted), 'new.wav')
  assert.throws(() => convertedFile({ file: 'wrong.wav', title: 'Wanted Dead or Alive - Bon Jovi' }, 'fallback.wav', wanted), /不一致/)
})

test('先校验身份再取音频；错误候选不能因为排名第一或可下载被选中', async () => {
  const calls = []
  const result = await selectSong(wanted, { catalog: catalog([wrong, right], id => { calls.push(id); return { url: 'fixture://audio' } }) })
  assert.equal(result.track.id, '2'); assert.deepEqual(calls, [2])
  await assert.rejects(selectSong(wanted, { catalog: catalog([wrong], () => assert.fail('不能下载错歌')) }), e =>
    e.code === 'SONG_MATCH_FAILED' && e.candidates[0].title === 'Wanted Dead or Alive - Bon Jovi')
  await assert.rejects(selectSong(wanted, { catalog: catalog([wrong, right], id => { assert.equal(id, 2); return { url: 'fixture://trial', trial: true } }) }), /没有可用的完整音频/)
  await assert.rejects(selectSong({ ...wanted, songId: 1 }, { catalog: catalog([wrong, right], () => assert.fail('ID 也必须校验歌手')) }), /未确认请求/)
  const selected = await selectSong({ songId: 2 }, { catalog: catalog([right]) })
  assert.equal(selected.track.title, 'Wanted Dead or Alive - 2Pac / Snoop Dogg')
})

test('已知无人声/用户否定的版本跳过，只在同一歌名与歌手内寻找可用版本', async () => {
  const alternate = { ...right, id: 3 }, calls = []
  const result = await selectSong({ ...wanted, rejectedResults: [{ trackId: '2' }] }, {
    catalog: catalog([wrong, right, alternate], id => { calls.push(id); return { url: 'fixture://audio' } }),
  })
  assert.equal(result.track.id, '3'); assert.deepEqual(calls, [3])
  await assert.rejects(selectSong(wanted, { catalog: catalog([wrong, right]), skip: ['2'] }), /没有人声/)
})

test('带元数据与SHA的正确缓存可用；旧缓存、内容损坏、错歌、纠错链均不复用', t => {
  const dir = mkdtempSync(join(tmpdir(), 'song-cache-match-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'source.mp3'), cached = join(dir, 'cache.mp3'), track = trackInfo(right)
  writeFileSync(source, 'ID3-audio'); writeFileSync(cached, 'old-unverified-cache')
  assert.equal(readSongCache(cached, wanted, track), null)
  const stored = writeSongCache(cached, source, { track, title: track.title, voice: 'fish', pitch: 12 }, wanted)
  const hit = readSongCache(cached, wanted, track)
  assert.equal(hit.cacheHit, true); assert.equal(hit.title, track.title); assert.equal(hit.sha256, audioHash(source))
  assert.equal(readSongCache(cached, { query: 'Wanted Dead or Alive Bon Jovi' }, track), null)
  assert.equal(readSongCache(cached, { ...wanted, correctsJobId: 'previous' }, track), null)
  assert.equal(readSongCache(cached, { ...wanted, rejectedResults: [{ sha256: stored.sha256 }] }, track), null)
  assert.throws(() => assertSongResult(stored, { ...wanted, rejectedResults: [{ sha256: stored.sha256 }] }), /已被本次纠错否定/)
  assert.equal(readSongCache(cached, wanted, trackInfo(wrong)), null)
  writeFileSync(cached, 'changed-audio')
  assert.equal(readSongCache(cached, wanted, track), null)
  assert.ok(JSON.parse(readFileSync(cached + '.json')).sha256)
})

test('缓存键区分实际曲目、转换脚本与音色/混音设置，保持同条件有效缓存', () => {
  const input = { scope: { account: '1', chat: 'group:1', persona: 'fish' }, track: trackInfo(right),
    voice: null, converter: 'script-hash-a', pitch: 12, settings: { maxVoiceSec: 120, vocalVolume: 1 } }
  assert.equal(songCacheKey(input), songCacheKey({ ...input }))
  for (const extra of [{ track: trackInfo(wrong) }, { converter: 'script-hash-b' }, { pitch: 0 }, { settings: { ...input.settings, vocalVolume: 2 } }]) {
    assert.notEqual(songCacheKey(input), songCacheKey({ ...input, ...extra }))
  }
})
