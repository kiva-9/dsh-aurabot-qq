import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { png } from './helpers/images.js'

test('persona panel reference routes work with imagegen off and enforce persona grants and stale edits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-persona-refs-host-'))
  const prior = Object.fromEntries(['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME'].map(k => [k, process.env[k]]))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: false, setupDone: true, botQQ: '20', ownerQQ: '10',
    snowluma: { autoStart: false, autoAttach: false }, modules: { imagegen: { enabled: false } } }))
  const fake = createFakeDsh({ brain: () => '' })
  t.after(async () => {
    await fake.dispose()
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(root, { recursive: true, force: true })
  })
  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx)
  await host.ready
  const call = async (path, body) => (await fake.call(path, body)).json()
  const initial = await call('/persona/references?id=dafeiyu')
  assert.equal(initial.ok, true); assert.ok(initial.defaultAssetId)
  assert.equal(initial.items.find(x => x.id === initial.defaultAssetId).inLibrary, false)
  const before = (await call('/persona/full?id=dafeiyu')).persona
  const oldLayers = structuredClone(before.published.layers)
  const layers = structuredClone(oldLayers)
  layers.appearance.referenceVariants = [{ assetId: initial.defaultAssetId, name: '原装', tags: ['日常'] }]
  layers.appearance.defaultReferenceAssetId = initial.defaultAssetId
  const stale = await call('/persona/draft', { id: 'dafeiyu', layers, editRevision: before.editRevision - 1 })
  assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE')
  assert.equal((await call('/persona/references?id=dafeiyu')).items.find(x => x.id === initial.defaultAssetId).inLibrary, false)
  const saved = await call('/persona/draft', { id: 'dafeiyu', layers, editRevision: before.editRevision })
  assert.equal(saved.ok, true)
  assert.equal((await call('/persona/references?id=dafeiyu')).items.find(x => x.id === initial.defaultAssetId).inLibrary, true)
  const published = await call('/persona/publish', { id: 'dafeiyu', editRevision: saved.persona.editRevision })
  assert.equal(published.ok, true)
  assert.deepEqual((await call('/persona/revision?id=dafeiyu&revision=1')).revision.layers, oldLayers)

  const created = await call('/persona/create', { id: 'other', name: 'other', layers: { appearance: { referenceAssetIds: [initial.defaultAssetId] } } })
  assert.equal(created.ok, true)
  const quarantined = await call('/persona/references?id=other')
  assert.equal(quarantined.items.find(x => x.id === initial.defaultAssetId).available, false)
  assert.equal((await call(`/persona/references/asset?id=other&assetId=${initial.defaultAssetId}`)).ok, false)
  assert.equal((await call('/persona/publish', { id: 'other', editRevision: created.persona.editRevision })).ok, false)
  assert.equal((await call('/persona/save', { id: 'other', body: 'a', editRevision: created.persona.editRevision })).ok, false)

  const data = `data:image/png;base64,${png(2, 2, 4).toString('base64')}`
  const uploaded = await call('/persona/references/upload', { id: 'other', data })
  assert.equal(uploaded.ok, true)
  const image = await fake.call(`/persona/references/asset?id=other&assetId=${uploaded.asset.id}`)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(image.headers['x-content-type-options'], 'nosniff')
  assert.ok(Buffer.isBuffer(image.raw()))
  assert.equal((await call(`/persona/references/asset?id=dafeiyu&assetId=${uploaded.asset.id}`)).ok, false)
  assert.equal((await call('/persona/references/upload', { id: 'other', data: 'data:text/html;base64,YQ==' })).ok, false)

  let history = (await call('/persona/create', { id: 'history', name: '历史测试', layers: { appearance: {} } })).persona
  const historyAsset = (await call('/persona/references/upload', { id: 'history', data })).asset.id
  const picked = { appearance: { referenceVariants: [{ assetId: historyAsset, name: '旧装', tags: [] }], defaultReferenceAssetId: historyAsset } }
  history = (await call('/persona/draft', { id: 'history', layers: picked, editRevision: history.editRevision })).persona
  assert.equal((await call('/persona/references/delete', { id: 'history', assetId: historyAsset })).code, 'IN_USE')
  history = (await call('/persona/publish', { id: 'history', editRevision: history.editRevision })).persona
  const oldRevision = (await call('/persona/revision?id=history&revision=1')).revision
  history = (await call('/persona/draft', { id: 'history', layers: { appearance: {} }, editRevision: history.editRevision })).persona
  assert.equal((await call('/persona/references/delete', { id: 'history', assetId: historyAsset })).code, 'IN_USE')
  history = (await call('/persona/publish', { id: 'history', editRevision: history.editRevision })).persona
  const removed = await call('/persona/references/delete', { id: 'history', assetId: historyAsset })
  assert.equal(removed.ok, true)
  assert.ok(!removed.library.items.some(x => x.id === historyAsset))
  assert.equal((await call('/persona/references/delete', { id: 'history', assetId: historyAsset })).code, 'NOT_FOUND')
  assert.equal((await call('/persona/draft', { id: 'history', layers: picked, editRevision: history.editRevision })).ok, false)
  assert.equal((await call('/persona/rollback', { id: 'history', revision: 1, editRevision: history.editRevision - 1 })).code, 'STALE')
  assert.ok(!(await call('/persona/references?id=history')).items.some(x => x.id === historyAsset), 'failed rollback cannot restore membership')
  const copied = (await call('/persona/duplicate', { id: 'history', newId: 'history_copy' })).persona
  assert.ok(!(await call('/persona/references?id=history_copy')).items.some(x => x.id === historyAsset))
  assert.equal((await call('/persona/draft', { id: copied.id, layers: picked, editRevision: copied.editRevision })).ok, false)
  const rolledBack = await call('/persona/rollback', { id: 'history', revision: 1, editRevision: history.editRevision })
  assert.equal(rolledBack.ok, true)
  assert.ok((await call('/persona/references?id=history')).items.some(x => x.id === historyAsset && x.inLibrary))
  assert.deepEqual((await call('/persona/revision?id=history&revision=1')).revision, oldRevision)
  assert.equal((await call('/persona/references/delete', { id: 'history', assetId: historyAsset })).code, 'IN_USE')
  assert.equal((await call('/persona/references/delete', { id: 'dafeiyu', assetId: initial.defaultAssetId })).code, 'BUILTIN_REFERENCE')
  assert.equal((await call('/persona/references/delete', { id: 'other', assetId: initial.defaultAssetId })).code, 'NOT_FOUND')
  assert.equal((await call('/persona/references/delete')).ok, false, 'GET cannot modify the library')
})
