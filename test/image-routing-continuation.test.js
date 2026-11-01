import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import imagegen from '../src/modules/imagegen/index.js'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'
import { PNG } from './helpers/images.js'

const profile = (id, modes, maxInputs) => ({
  id, name: id, protocol: 'openai', baseUrl: `https://${id}.invalid/v1`, model: id,
  capabilities: { modes, maxInputs }, extra: {},
})

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-continuation-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const config = normalize({ botQQ: '20', ownerQQ: '10', imageGen: {
    enabled: true, defaultProfile: 'studio-wai',
    profiles: [
      profile('studio-wai', ['text'], 0),
      profile('legacy-grsai', ['text', 'reference'], 1),
      profile('magpie-codex', ['text', 'reference', 'edit'], 5),
      profile('other-editor', ['text', 'reference', 'edit'], 5),
    ],
    routing: { text: 'studio-wai', singleReference: 'legacy-grsai', multiReference: 'magpie-codex' },
  } })
  const persona = { personaId: 'cat', revision: 1, bindingRevision: 1, layers: {} }
  const routes = new Map()
  const api = imagegen.setup({
    core: { storage, hub: { personaFor: () => persona }, local: { active: () => false }, http: { body: async r => r } },
    config: () => config, lazy: () => ({}), log: { info() {}, warn() {} },
    every() {}, tool() {}, onDispose() {}, route: (path, fn) => routes.set(path, fn),
  })
  // Enqueue through the real panel route, but never start the provider worker.
  api.runner.kick = () => {}
  t.after(async () => { await api.runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })

  const identity = storage.assets.put(readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url)), { mime: 'image/jpeg' })
  const output = storage.assets.put(PNG, { mime: 'image/png' })
  const parent = api.runner.enqueue({
    kind: 'image', chatId: 'private:10', actorId: '10', profileId: 'legacy-grsai',
    input: { prompt: 'parent', mode: 'reference', refs: [{ assetId: identity.id, role: 'identity' }],
      accountId: '20', persona: { personaId: 'cat', revision: 1, bindingRevision: 1 } },
  })
  // Model an already delivered parent without calling a provider or sending a message.
  storage.db.run("UPDATE jobs SET state = 'delivered', output_json = ? WHERE id = ?", JSON.stringify({ assetIds: [output.id] }), parent.id)
  const submit = (profileId = '') => routes.get('/imagegen/submit')({
    chatId: 'private:10', prompt: 'continue editing', parentJobId: parent.id,
    refs: [{ assetId: output.id, role: 'base' }], profileId,
  })
  return { api, parent, identity, output, submit }
}

test('panel continuation routes the base and inherited reference together', async t => {
  const s = setup(t)
  const result = await s.submit()
  assert.equal(result.ok, true, result.message)
  assert.equal(result.job.parentJobId, s.parent.id)
  assert.equal(result.job.profileId, 'magpie-codex')
  assert.equal(result.job.input.mode, 'edit')
  assert.deepEqual(result.job.input.refs.map(({ assetId, role }) => ({ assetId, role })), [
    { assetId: s.output.id, role: 'base' },
    { assetId: s.identity.id, role: 'identity' },
  ])
})

test('an explicit compatible service overrides the multi-input preference', async t => {
  const s = setup(t)
  const result = await s.submit('other-editor')
  assert.equal(result.ok, true, result.message)
  assert.equal(result.job.profileId, 'other-editor')
  assert.equal(result.job.input.mode, 'edit')
  assert.equal(result.job.input.refs.length, 2)
})

test('an explicitly selected incompatible service fails without falling back', async t => {
  const s = setup(t)
  const result = await s.submit('legacy-grsai')
  assert.equal(result.ok, false)
  assert.match(result.message, /legacy-grsai/)
  assert.match(result.message, /不支持/)
  assert.equal(s.api.runner.list().length, 1) // Only the synthetic delivered parent exists.
})
