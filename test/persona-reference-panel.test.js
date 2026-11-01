import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const source = client.slice(client.indexOf('    function PersonaReferenceTags('), client.indexOf('    function PersonaRvc('))
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const asset = (id, more = {}) => ({ id, mime: 'image/jpeg', available: true, inLibrary: true, ...more })
const list = (items = [], builtin = 'builtin') => ({ ok: true, items: [...(builtin ? [asset(builtin, { inLibrary: false })] : []), ...items], defaultAssetId: builtin, useDefaultReferenceAvailable: true })

function mount({ get, post, appearance = {}, personaId = 'dafeiyu', draftAppearance, publishedAppearance, confirm = () => true } = {}) {
  const instances = new Map(), calls = [], notices = []; let slots, cursor, effects = [], seen, tree, identity = 0
  const hooks = {
    useState(initial) { const state = slots, i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v }] },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useEffect(fn, deps) { const state = slots, i = cursor++; if (!same(state[i]?.deps, deps)) { const old = state[i]; state[i] = { deps }; effects.push(() => { old?.cleanup?.(); state[i].cleanup = fn() }) } },
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
  class FileReader {
    readAsDataURL(file) { queueMicrotask(() => { if (file.fail) this.onerror(); else { this.result = file.data || 'data:image/jpeg;base64,YQ=='; this.onload() } }) }
  }
  const context = { ...hooks, h, FileReader, URLSearchParams, API: '/fake', Btn: 'Btn', confirm,
    async get(path) { calls.push({ path }); return get ? get(path) : list() },
    async post(path, body) { calls.push({ path, body: plain(body) }); return post ? post(path, body) : { ok: true, asset: asset('new-photo') } },
  }
  runInNewContext(source + '\nglobalThis.parts={PersonaReferences,PersonaReferenceTags}', context)
  const props = { personaId, appearance: structuredClone(appearance), draftAppearance, publishedAppearance, profile: { id: 'one', name: 'One', capabilities: { maxInputs: 1 } },
    isCurrent: () => true, toast: (...args) => notices.push(args), onChange: update => { props.appearance = update(props.appearance) } }
  const invoke = (type, args, key) => { if (!instances.has(key)) instances.set(key, []); seen.add(key); slots = instances.get(key); cursor = 0; return type(args) }
  const expand = (node, key) => {
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function' && node.type.name === 'PersonaReferenceTags') {
      const child = key + ':' + node.type.name + ':' + (node.props.key || 'single')
      return { ...node, children: [expand(invoke(node.type, node.props, child), child)] }
    }
    return { ...node, children: node.children.map((c, i) => expand(c, key + '/' + (c?.props?.key ?? i))) }
  }
  const render = () => {
    seen = new Set(); tree = expand(invoke(context.parts.PersonaReferences, props, 'root'), 'root')
    for (const [key, state] of instances) if (!seen.has(key)) { state.forEach(s => s?.cleanup?.()); instances.delete(key) }
    const todo = effects; effects = []; todo.forEach(fn => fn()); return tree
  }
  const flush = async () => { render(); await tick(); render(); await tick(); return render() }
  const nodes = (root = tree) => root && typeof root === 'object' ? [root, ...root.children.flatMap(c => nodes(c))] : []
  const label = n => n && typeof n === 'object' ? n.children.map(label).join('') : String(n ?? '')
  const byAria = text => { const n = nodes().find(n => n.props['aria-label'] === text); assert.ok(n, text); return n.props }
  const card = id => { const n = nodes().find(n => n.props.className === 'ab-pref-item' && nodes(n).some(child => child.props.className === 'ab-pref-id' && label(child) === id)); assert.ok(n, id); return n }
  const btn = (text, within = tree) => { const n = nodes(within).find(n => n.type === 'Btn' && label(n) === text); assert.ok(n, text); return n.props }
  const choose = (id, checked = true) => { const input = nodes(card(id)).find(n => n.type === 'input' && n.props.type === 'checkbox'); assert.ok(input); assert.equal(input.props.disabled, false); input.props.onChange({ target: { checked } }); render() }
  const radio = id => { const n = nodes(card(id)).find(n => n.type === 'input' && n.props.type === 'radio'); assert.ok(n, id); return n.props }
  const switchTo = (id, nextAppearance = {}) => { identity++; const captured = identity; props.personaId = id; props.appearance = nextAppearance; props.isCurrent = () => identity === captured; render() }
  return { render, flush, nodes, label, byAria, card, btn, choose, radio, switchTo, props, calls, notices,
    unmount() { identity++; for (const state of instances.values()) state.forEach(s => s?.cleanup?.()); instances.clear() } }
}

test('outfit candidates, names, tags and default update only the current draft', async () => {
  const original = { text: '原本外观', referenceAssetIds: [], useDefaultReference: true, extra: 'keep' }
  const ui = mount({ appearance: original, get: () => list([asset('a'), asset('b')]) }); await ui.flush()
  assert.match(ui.label(ui.render()), /每次自拍只使用一张照片/)
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
  ui.choose('a'); ui.choose('b')
  assert.equal(ui.props.appearance.referenceVariants.length, 2)
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
  ui.byAria('照片 1的造型名称').onChange({ target: { value: '夏日裙装' } }); ui.render()
  ui.byAria('照片 1的新标签').onChange({ target: { value: '海边' } }); ui.render()
  ui.btn('添加标签', ui.card('a')).onClick(); ui.render()
  ui.radio('b').onChange(); ui.render()
  assert.deepEqual(plain(ui.props.appearance.referenceVariants), [{ assetId: 'a', name: '夏日裙装', tags: ['海边'] }, { assetId: 'b', name: '', tags: [] }])
  assert.equal(ui.props.appearance.defaultReferenceAssetId, 'b')
  assert.equal(ui.props.appearance.text, '原本外观'); assert.equal(ui.props.appearance.extra, 'keep')
  assert.deepEqual(plain(ui.props.appearance.referenceAssetIds), [])
  assert.deepEqual(ui.calls.map(c => c.path.split('?')[0]), ['/persona/references'])
  assert.deepEqual(original, { text: '原本外观', referenceAssetIds: [], useDefaultReference: true, extra: 'keep' })
  ui.choose('b', false)
  assert.equal(ui.props.appearance.defaultReferenceAssetId, '')
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
})

test('a maximum of eight candidates is enforced and missing defaults are visible', async () => {
  const photos = Array.from({ length: 9 }, (_, i) => asset('p' + i))
  const ui = mount({ get: () => list(photos) }); await ui.flush()
  for (let i = 0; i < 8; i++) ui.choose('p' + i)
  const ninth = ui.nodes(ui.card('p8')).find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(ninth.props.disabled, true); assert.match(ui.label(ui.render()), /最多选择 8 张/)
  const missing = mount({ appearance: { referenceVariants: [{ assetId: 'gone', name: '礼服', tags: [] }], defaultReferenceAssetId: 'gone' }, get: () => list([asset('gone', { available: false })]) })
  await missing.flush(); assert.match(missing.label(missing.render()), /默认自拍参考照片不可用/)
  missing.choose('gone', false); assert.deepEqual(plain(missing.props.appearance.referenceVariants), [])
  const noImage = mount({ get: () => ({ ok: true, items: [], defaultAssetId: null, useDefaultReferenceAvailable: false }) })
  await noImage.flush(); assert.match(noImage.label(noImage.render()), /没有可用的默认自拍参考照片/)
})

test('legacy photos move into candidates and builtin remains a separate default', async () => {
  const ui = mount({ appearance: { referenceAssetIds: ['old-a', 'old-b'], defaultReferenceAssetId: 'old-a' }, get: () => list([asset('old-a'), asset('old-b')]) })
  await ui.flush(); assert.match(ui.label(ui.render()), /旧版参考照片/)
  ui.btn('转为造型候选').onClick(); ui.render()
  assert.deepEqual(plain(ui.props.appearance.referenceAssetIds), [])
  assert.deepEqual(plain(ui.props.appearance.referenceVariants).map(v => v.assetId), ['old-a', 'old-b'])
  assert.equal(ui.props.appearance.defaultReferenceAssetId, 'old-a')
  const builtinLabel = ui.nodes().find(n => n.type === 'label' && ui.label(n) === '默认使用大肥鱼原图')
  builtinLabel.children[0].props.onChange(); ui.render()
  assert.equal(ui.props.appearance.defaultReferenceAssetId, ''); assert.equal(ui.props.appearance.useDefaultReference, true)
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
  ui.choose('old-a', false); ui.choose('old-b', false)
  assert.deepEqual(plain(ui.props.appearance.referenceVariants), []); assert.deepEqual(plain(ui.props.appearance.referenceAssetIds), [])
  assert.doesNotMatch(ui.label(ui.render()), /旧版参考照片/)
  const single = mount({ appearance: { referenceAssetIds: ['old-a'] }, get: () => list([asset('old-a')]) })
  await single.flush(); single.btn('清除旧版参考照片').onClick(); single.render()
  assert.deepEqual(plain(single.props.appearance.referenceAssetIds), [])
  assert.match(single.label(single.render()), /默认参考照片：大肥鱼原图/)
})

test('the builtin portrait can be a named outfit and an independently selected default', async () => {
  const ui = mount({ get: () => list([asset('other')]) }); await ui.flush()
  ui.choose('builtin'); ui.byAria('大肥鱼原图的造型名称').onChange({ target: { value: '原画' } }); ui.render()
  ui.byAria('大肥鱼原图的新标签').onChange({ target: { value: '日常' } }); ui.render()
  ui.btn('添加标签', ui.card('builtin')).onClick(); ui.render()
  assert.deepEqual(plain(ui.props.appearance.referenceVariants), [{ assetId: 'builtin', name: '原画', tags: ['日常'] }])
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
  ui.choose('other'); ui.radio('other').onChange(); ui.render()
  assert.equal(ui.props.appearance.defaultReferenceAssetId, 'other')
})

test('mixed legacy and variant configurations cannot silently reactivate old photos', async () => {
  const ui = mount({ appearance: { referenceAssetIds: ['old'], referenceVariants: [{ assetId: 'new', name: '', tags: [] }], defaultReferenceAssetId: 'new' }, get: () => list([asset('old'), asset('new')]) })
  await ui.flush()
  assert.match(ui.label(ui.render()), /移除最后一个造型前/)
  assert.equal(ui.nodes(ui.card('new')).find(n => n.type === 'input' && n.props.type === 'checkbox').props.disabled, true)
  ui.btn('清除旧版参考照片').onClick(); ui.render(); ui.choose('new', false)
  assert.deepEqual(plain(ui.props.appearance.referenceAssetIds), []); assert.deepEqual(plain(ui.props.appearance.referenceVariants), [])
  assert.match(ui.label(ui.render()), /默认参考照片：大肥鱼原图/)
})

test('uploads validate files, do not select them, and survive a slower library read', async () => {
  const pending = deferred(), ui = mount({ get: () => pending.promise }); ui.render()
  const upload = file => ui.byAria('上传人设参考照片').onChange({ target: { files: [file], value: 'x' } })
  upload({ type: 'text/plain', size: 10 }); ui.render(); assert.match(ui.label(ui.render()), /请选择 JPEG/)
  upload({ type: 'image/jpeg', size: 6 * 1024 * 1024 }); ui.render(); assert.match(ui.label(ui.render()), /不超过 5 MB/)
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  upload({ type: 'image/jpeg', size: 10 }); await tick(); await ui.flush()
  assert.ok(ui.card('new-photo')); assert.equal(ui.props.appearance.referenceVariants, undefined)
  assert.deepEqual(ui.calls.filter(c => c.body).map(c => c.path), ['/persona/references/upload'])
  pending.resolve(list([])); await ui.flush(); assert.ok(ui.card('new-photo'))
  assert.equal(ui.notices.length, 1)
})

test('late library and upload responses cannot update a different or reselected persona', async () => {
  const oldList = deferred(), oldUpload = deferred(); let first = true
  const ui = mount({ get: path => {
    const id = new URL(path, 'http://test').searchParams.get('id')
    if (id === 'dafeiyu' && first) { first = false; return oldList.promise }
    return id === 'other' ? list([asset('other-photo')]) : list([asset('fresh-photo')])
  }, post: () => oldUpload.promise })
  ui.render(); ui.byAria('上传人设参考照片').onChange({ target: { files: [{ type: 'image/jpeg', size: 10 }], value: 'x' } }); await tick()
  ui.switchTo('other'); await ui.flush(); assert.ok(ui.card('other-photo'))
  ui.switchTo('dafeiyu'); await ui.flush(); assert.ok(ui.card('fresh-photo'))
  oldList.resolve(list([asset('stale-list')])); oldUpload.resolve({ ok: true, asset: asset('stale-upload') }); await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /stale-list|stale-upload/)
  assert.deepEqual(ui.notices, []); assert.equal(ui.props.appearance.referenceVariants, undefined)
})

test('deleting requires clearing unsaved, saved draft and published uses; builtin stays available', async () => {
  const ap = { text: '保留外观', referenceVariants: [{ assetId: 'local', name: '裙装', tags: [] }], defaultReferenceAssetId: 'local' }
  const ui = mount({ appearance: ap, draftAppearance: { referenceAssetIds: ['draft'] },
    publishedAppearance: { referenceVariants: [{ assetId: 'online' }] }, get: () => list([asset('local'), asset('draft'), asset('online'), asset('free')]) })
  await ui.flush()
  for (const id of ['local', 'draft', 'online']) assert.equal(ui.btn('从图库删除', ui.card(id)).disabled, true)
  assert.equal(ui.btn('从图库删除', ui.card('free')).disabled, false)
  assert.equal(ui.nodes(ui.card('builtin')).some(n => n.type === 'Btn' && ui.label(n) === '从图库删除'), false)
  assert.match(ui.label(ui.render()), /编辑框已选/); assert.match(ui.label(ui.render()), /草稿或线上仍使用/)
  assert.match(ui.label(ui.render()), /历史版本的底层图片仍保留/)
  assert.deepEqual(plain(ui.props.appearance), ap); assert.equal(ui.calls.filter(c => c.body).length, 0)
  ui.choose('local', false); assert.equal(ui.btn('从图库删除', ui.card('local')).disabled, false)
  assert.equal(ui.props.appearance.text, '保留外观')
})

test('cancelled deletion leaves the library unchanged and backend conflicts explain next steps', async () => {
  const cancelled = mount({ get: () => list([asset('one')]), confirm: () => false }); await cancelled.flush()
  await cancelled.btn('从图库删除', cancelled.card('one')).onClick(); await cancelled.flush()
  assert.ok(cancelled.card('one')); assert.equal(cancelled.calls.filter(c => c.body).length, 0)
  const conflict = mount({ get: () => list([asset('one')]), post: () => ({ ok: false, code: 'IN_USE' }) }); await conflict.flush()
  await conflict.btn('从图库删除', conflict.card('one')).onClick(); await conflict.flush()
  assert.ok(conflict.card('one')); assert.match(conflict.label(conflict.render()), /取消选择并保存草稿或发布/)
  assert.deepEqual(conflict.calls.filter(c => c.body).map(c => c.path), ['/persona/references/delete'])
})

test('an unselected missing photo can still be removed from the library', async () => {
  const ui = mount({ get: () => list([asset('missing', { available: false })]), post: () => ({ ok: true, library: list([]) }) })
  await ui.flush(); assert.match(ui.label(ui.card('missing')), /不可用/)
  assert.equal(ui.btn('从图库删除', ui.card('missing')).disabled, false)
  await ui.btn('从图库删除', ui.card('missing')).onClick(); await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /missing/)
})

test('deletion blocks stale clicks and uploads, defeats older reads, and reupload restores the photo', async () => {
  const oldList = deferred(), deleteReply = deferred(); let deleted = false
  const ui = mount({ get: () => oldList.promise, post: path => {
    if (path === '/persona/references/upload') return { ok: true, asset: asset('new-photo') }
    if (path === '/persona/references/delete') { deleted = true; return deleteReply.promise }
  } })
  ui.render()
  const upload = () => ui.byAria('上传人设参考照片').onChange({ target: { files: [{ type: 'image/jpeg', size: 10 }], value: 'x' } })
  upload(); await ui.flush(); assert.ok(ui.card('new-photo'))
  const staleCheck = ui.nodes(ui.card('new-photo')).find(n => n.type === 'input' && n.props.type === 'checkbox').props
  const deleting = ui.btn('从图库删除', ui.card('new-photo')).onClick(); ui.render()
  assert.equal(deleted, true); assert.match(ui.label(ui.render()), /删除中/)
  staleCheck.onChange({ target: { checked: true } }); upload(); ui.render()
  assert.equal(ui.props.appearance.referenceVariants, undefined)
  assert.deepEqual(ui.calls.filter(c => c.body).map(c => c.path), ['/persona/references/upload', '/persona/references/delete'])
  deleteReply.resolve({ ok: true, library: list([]) }); await deleting; await ui.flush()
  oldList.resolve(list([asset('new-photo')])); await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /new-photo/)
  upload(); await ui.flush(); assert.ok(ui.card('new-photo'))
  assert.equal(ui.props.appearance.referenceVariants, undefined)
})

test('authoritative deletion responses clear stale local upload caches and preserve unrelated edits', async () => {
  const ui = mount({ appearance: { text: '未保存的外观', extra: 'keep' }, get: () => list([asset('other')]),
    post: path => path.endsWith('/upload') ? { ok: true, asset: asset('new-photo') } : { ok: true, library: list([]) } })
  await ui.flush()
  ui.byAria('上传人设参考照片').onChange({ target: { files: [{ type: 'image/jpeg', size: 10 }], value: 'x' } }); await ui.flush()
  assert.ok(ui.card('new-photo'))
  await ui.btn('从图库删除', ui.card('other')).onClick(); await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /new-photo|other/)
  assert.deepEqual(plain(ui.props.appearance), { text: '未保存的外观', extra: 'keep' })
})

test('a fresh library read removes an upload deleted elsewhere', async () => {
  let reads = 0
  const ui = mount({ get: () => ++reads === 1 ? { ok: false, message: '读取失败' } : list([]) })
  await ui.flush()
  ui.byAria('上传人设参考照片').onChange({ target: { files: [{ type: 'image/jpeg', size: 10 }], value: 'x' } }); await ui.flush()
  assert.ok(ui.card('new-photo'))
  await ui.btn('重试读取').onClick(); await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /new-photo/)
})

test('a stale retry started during deletion cannot resurrect a removed photo', async () => {
  const retry = deferred(), deletion = deferred(); let reads = 0
  const ui = mount({ get: () => ++reads === 1 ? { ok: false, message: '读取失败' } : retry.promise,
    post: path => path.endsWith('/upload') ? { ok: true, asset: asset('new-photo') } : deletion.promise })
  await ui.flush()
  ui.byAria('上传人设参考照片').onChange({ target: { files: [{ type: 'image/jpeg', size: 10 }], value: 'x' } }); await ui.flush()
  const staleRetry = ui.btn('重试读取')
  const pendingDelete = ui.btn('从图库删除', ui.card('new-photo')).onClick(); ui.render()
  const pendingRead = staleRetry.onClick()
  deletion.resolve({ ok: true, library: list([]) }); await pendingDelete; await ui.flush()
  retry.resolve(list([asset('new-photo')])); await pendingRead; await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /new-photo/)
})

test('late deletion responses cannot change a different or reselected persona', async () => {
  const reply = deferred()
  const ui = mount({ get: path => list([asset(new URL(path, 'http://test').searchParams.get('id') + '-photo')]), post: () => reply.promise })
  await ui.flush(); const pending = ui.btn('从图库删除', ui.card('dafeiyu-photo')).onClick()
  ui.switchTo('other'); await ui.flush(); ui.switchTo('dafeiyu'); await ui.flush()
  reply.resolve({ ok: true, library: list([asset('stale-photo')]) }); await pending; await ui.flush()
  assert.ok(ui.card('dafeiyu-photo')); assert.doesNotMatch(ui.label(ui.render()), /stale-photo/)
  assert.deepEqual(ui.notices, [])
})

test('persona draft saving preserves reference edits and edits made during the save', async () => {
  const personaSource = client.slice(client.indexOf('    function Persona('), client.indexOf('    function EffectivePrompt('))
  const layers = { identity: { name: 'Fish', callOwner: '', core: '其他设定' }, behavior: { proactivity: 'normal', text: '' },
    style: { text: '', examples: [], banned: [] }, appearance: { text: '原外观', referenceAssetIds: [] },
    voice: { voice: 'original', speed: 1 }, policy: {}, tags: [] }
  const card = { id: 'fish', name: 'Fish', editRevision: 1, draft: { layers }, published: null }
  const states = [[{ id: 'fish', name: 'Fish', tags: [], origin: 'user', revision: 0 }], [], false, 'fish', card, [], { name: 'Fish', layers: structuredClone(layers) }, false, 'edit', null]
  const refs = [], calls = [], reply = deferred(); let stateIndex = 0, refIndex = 0
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) })
  const setPath = (o, path, v) => { const x = structuredClone(o), keys = path.split('.'); let cur = x; for (const key of keys.slice(0, -1)) cur = cur[key]; cur[keys.at(-1)] = v; return x }
  const ctx = { h, Card: 'Card', Row: 'Row', Btn: 'Btn', Switch: 'Switch', Seg: 'Seg', Range: 'Range', ListArea: 'ListArea', Empty: 'Empty',
    ImportPersona: 'ImportPersona', PersonaBindings: 'PersonaBindings', AvatarCard: 'AvatarCard', PolishLayer: 'PolishLayer', PersonaRvc: 'PersonaRvc', PersonaReferences: 'PersonaReferences', LegacyPersonaEditor: 'LegacyPersonaEditor', EffectivePrompt: 'EffectivePrompt', PersonaPreview: 'PersonaPreview', PersonaRevision: 'PersonaRevision',
    PROACTIVITY: [], ORIGIN: {}, cx: (...x) => x.filter(Boolean).join(' '), clone: structuredClone, setPath, getPath: (o, p) => p.split('.').reduce((v, k) => v?.[k], o),
    useState: v => { const i = stateIndex++; if (!(i in states)) states[i] = v; return [states[i], x => { states[i] = typeof x === 'function' ? x(states[i]) : x }] },
    useRef: v => { const i = refIndex++; return refs[i] || (refs[i] = { current: v }) }, useEffect() {}, confirm: () => true,
    get: async () => ({ ok: true, list: states[0], bindings: [] }), post: (path, body) => { calls.push({ path, body: plain(body) }); return reply.promise } }
  runInNewContext(personaSource + '\nglobalThis.render=Persona', ctx)
  const render = () => { stateIndex = 0; refIndex = 0; return ctx.render({ st: { config: { persona: { current: 'fish' } } }, toast() {}, reload() {} }) }
  const all = root => { const out = []; const walk = n => { if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach(walk) } }; walk(root); return out }
  const tree = all(render()), control = tree.find(n => n.type === 'PersonaReferences').props
  control.onChange(ap => ({ ...ap, referenceVariants: [{ assetId: 'one', name: '夏装', tags: ['海边'] }], defaultReferenceAssetId: 'one' }))
  tree.find(n => n.type === 'textarea' && String(n.props.placeholder || '').startsWith('外观')).props.onChange({ target: { value: '新外观' } })
  assert.equal(states[6].layers.appearance.text, '新外观'); assert.equal(states[6].layers.appearance.referenceVariants[0].assetId, 'one')
  assert.equal(states[6].layers.identity.core, '其他设定'); assert.equal(states[6].layers.voice.voice, 'original'); assert.equal(calls.length, 0)
  const save = all(render()).find(n => n.type === 'Btn' && n.children.includes('存草稿'))
  const pending = save.props.onClick()
  assert.deepEqual(calls.map(c => c.path), ['/persona/draft']); assert.equal(calls[0].body.layers.appearance.defaultReferenceAssetId, 'one')
  all(render()).find(n => n.type === 'PersonaReferences').props.onChange(ap => ({ ...ap, referenceVariants: [...ap.referenceVariants, { assetId: 'two', name: '冬装', tags: [] }] }))
  reply.resolve({ ok: true, persona: { ...card, editRevision: 2, draft: { layers: calls[0].body.layers } } }); await pending
  assert.deepEqual(plain(states[6].layers.appearance.referenceVariants).map(v => v.assetId), ['one', 'two'])
  assert.equal(states[7], true); assert.deepEqual(calls.map(c => c.path), ['/persona/draft'])
})
