import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { videoFrame, previewFrame } from '../src/bili/frames.js'

test('real local FFmpeg decodes bounded video and crops a preview through pipe only', async t => {
  const version = spawnSync('ffmpeg', ['-version'], { windowsHide: true })
  if (version.error?.code === 'ENOENT') return t.skip('ffmpeg 不在 PATH 中')
  const make = args => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 })
    assert.equal(result.status, 0, String(result.stderr)); return result.stdout
  }
  const sprite = make(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe'])
  const thumbnail = await previewFrame(sprite, { columns: 2, rows: 2, index: 3 })
  assert.deepEqual([...thumbnail.subarray(0, 2)], [0xff, 0xd8])
  const video = make(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=4', '-t', '2', '-c:v', 'mpeg4', '-f', 'matroska'])
  const frame = await videoFrame(video, 1)
  assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8])
  await assert.rejects(previewFrame(sprite, { columns: 1000, rows: 1, index: 0 }), /网格无效/)
})

test('frame abort waits for the child to close and never grants FFmpeg network protocols', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let killed = 0, executable, args
  child.kill = () => { killed++; return true }
  const controller = new AbortController()
  const pending = videoFrame(Buffer.from('video'), 1, { signal: controller.signal, ffmpeg: 'configured-exe', spawnImpl: (cmd, argv) => { executable = cmd; args = argv; return child } })
  let settled = false; pending.catch(() => { settled = true })
  controller.abort(new Error('cancelled'))
  await Promise.resolve()
  assert.equal(killed, 1); assert.equal(settled, false); assert.equal(executable, 'configured-exe')
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe')
  assert.ok(!args.some(arg => /^https?:/i.test(arg)))
  child.emit('close', 1)
  await assert.rejects(pending, /cancelled/)
})
