import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const source = client.slice(client.indexOf('    function parseLegacySections('), client.indexOf('    function Persona('))
const plain = value => JSON.parse(JSON.stringify(value))

function mount(value) {
  const states = [], changes = []; let cursor = 0, tree
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
  const context = { h, useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }] } }
  runInNewContext(source + '\nglobalThis.parts={parseLegacySections,editLegacyTextarea,LegacyPersonaEditor}', context)
  const props = { value, onChange(next) { changes.push(next); props.value = next } }
  const render = () => { cursor = 0; tree = context.parts.LegacyPersonaEditor(props); return tree }
  const nodes = (root = tree) => root && typeof root === 'object' ? [root, ...root.children.flatMap(c => nodes(c))] : []
  const text = n => n && typeof n === 'object' ? n.children.map(text).join('') : String(n ?? '')
  const button = label => { const n = nodes().find(n => n.type === 'button' && text(n).includes(label)); assert.ok(n, label); return n.props }
  const input = label => { const n = nodes().find(n => n.type === 'textarea' && n.props['aria-label'] === label); assert.ok(n, label); return n.props }
  render()
  return { props, changes, parts: context.parts, render, nodes, text, button, input }
}

test('only standalone headings outside fenced blocks split sections; headings and separators stay untouched', () => {
  const original = '前言\r\n```md\r\n【假标题】\r\n```\r\n- 【列表强调】\r\n\r\n\u200b 【第一节】 \u200b\r\n第一行\r\n第二行\n\r\n【第一节】\n【末尾】'
  const ui = mount(original), parts = ui.parts.parseLegacySections(original)
  assert.deepEqual(plain(parts).map(part => part.title), ['标题前的原文', '第一节', '第一节', '末尾'])
  assert.match(original.slice(parts[0].start, parts[0].end), /【假标题】/)
  assert.match(original.slice(parts[0].start, parts[0].end), /- 【列表强调】/)
  assert.equal(original.slice(parts[1].start, parts[1].end), '第一行\r\n第二行')
  assert.equal(original.slice(parts[2].start, parts[2].end), '')
  assert.equal(parts[3].needsNewline, true)
  assert.equal(ui.props.value, original); assert.deepEqual(ui.changes, [])
})

test('the bundled dafeiyu legacy description exposes its real sections without splitting list emphasis', () => {
  const persona = JSON.parse(readFileSync(new URL('../personas/dafeiyu.persona.json', import.meta.url), 'utf8'))
  const original = persona.layers.legacy.body, ui = mount(original)
  const titles = plain(ui.parts.parseLegacySections(original)).map(part => part.title)
  assert.ok(titles.includes('你的样子')); assert.ok(titles.includes('打字习惯')); assert.ok(titles.includes('最后自检'))
  assert.equal(titles.includes('重点偏好'), false)
  assert.equal(ui.props.value, original); assert.deepEqual(ui.changes, [])
})

test('collapsing, expanding, and switching full text never edit or normalize the draft', () => {
  const original = '前言\r\n\r\n【一】\r\n正文\n\r\n【二】\n更多\r\n'
  const ui = mount(original), headings = ui.nodes().filter(n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(headings[0].props['aria-expanded'], true); assert.equal(headings[1].props['aria-expanded'], false)
  headings[0].props.onClick(); ui.render(); assert.equal(ui.button('标题前的原文')['aria-expanded'], false)
  ui.button('一').onClick(); ui.render(); assert.equal(ui.button('一')['aria-expanded'], true)
  ui.button('编辑完整原文').onClick(); ui.render()
  assert.equal(ui.input('完整旧版人设原文').value, original.replace(/\r\n?/g, '\n'))
  ui.button('按章节编辑').onClick(); ui.render()
  assert.equal(ui.props.value, original); assert.deepEqual(ui.changes, [])
  assert.match(ui.text(ui.render()), /自拍参考图和外观补充在下方「样子与声音」管理/)
})

test('editing a section preserves other headings, separator whitespace and mixed line endings', () => {
  const original = '开场\r\n\r\n【人格】\r\n第一行\r\n第二行\n第三行\r\n  \r\n【固定】\n不可改变\r\n'
  const ui = mount(original)
  ui.input('编辑第 1 节 标题前的原文').onChange({ target: { value: '开篇' } }); ui.render()
  assert.equal(ui.props.value, original.replace('开场', '开篇'))
  ui.button('人格').onClick(); ui.render()
  const editor = ui.input('编辑第 2 节 人格')
  assert.equal(editor.value, '第一行\n第二行\n第三行')
  editor.onChange({ target: { value: '第一行修订\n第二行\n第三行' } }); ui.render()
  assert.equal(ui.props.value, '开篇\r\n\r\n【人格】\r\n第一行修订\r\n第二行\n第三行\r\n  \r\n【固定】\n不可改变\r\n')
  const before = ui.props.value, same = ui.input('编辑第 2 节 人格').value
  ui.input('编辑第 2 节 人格').onChange({ target: { value: same } }); ui.render()
  assert.equal(ui.props.value, before); assert.equal(ui.changes.length, 2)
})

test('no headings uses full editor; raw edits preserve unrelated CRLF and mixed newlines', () => {
  const original = '第一行\r\n第二行\n第三行\r末行'
  const ui = mount(original)
  assert.match(ui.text(ui.render()), /没有找到独占一行/)
  assert.equal(ui.input('完整旧版人设原文').value, '第一行\n第二行\n第三行\n末行')
  ui.input('完整旧版人设原文').onChange({ target: { value: '第一行\n第二行修改\n第三行\n末行' } }); ui.render()
  assert.equal(ui.props.value, '第一行\r\n第二行修改\n第三行\r末行')
  assert.equal(ui.parts.editLegacyTextarea('甲\r\n乙\n丙', '甲改\n乙\n丙改'), '甲改\r\n乙\n丙改')
})

test('duplicate and empty sections remain distinct; editing an unterminated last heading adds only the necessary newline', () => {
  const ui = mount('【同名】\n【同名】\n正文\n【末尾】')
  assert.equal(ui.nodes().filter(n => n.type === 'button' && ui.text(n).includes('同名')).length, 2)
  ui.button('末尾').onClick(); ui.render()
  ui.input('编辑第 3 节 末尾').onChange({ target: { value: '新增' } }); ui.render()
  assert.equal(ui.props.value, '【同名】\n【同名】\n正文\n【末尾】\n新增')
})

test('editing legacy text in Persona preserves the outfit configuration and stays local until draft save', async () => {
  const code = client.slice(client.indexOf('    function Persona('), client.indexOf('    function EffectivePrompt('))
  const layers = { identity: { name: 'Fish', callOwner: '', core: '' }, behavior: { proactivity: 'normal', text: '' },
    style: { text: '', examples: [], banned: [] }, appearance: { text: '外观补充', referenceAssetIds: [], referenceVariants: [{ assetId: 'a', name: '夏装', tags: ['海边'] }], defaultReferenceAssetId: 'a' },
    voice: { voice: '', speed: 1 }, policy: {}, tags: [], legacy: { body: '【身份】\r\n原文\r\n' } }
  const card = { id: 'fish', name: 'Fish', editRevision: 1, draft: { layers }, published: null }
  const states = [[{ id: 'fish', name: 'Fish', tags: [], origin: 'user', revision: 0 }], [], false, 'fish', card, [], { name: 'Fish', layers: structuredClone(layers) }, false, 'edit', null]
  const refs = [], calls = []; let stateIndex = 0, refIndex = 0
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) })
  const setPath = (o, path, v) => { const result = structuredClone(o), keys = path.split('.'); let current = result; for (const key of keys.slice(0, -1)) current = current[key]; current[keys.at(-1)] = v; return result }
  const ctx = { h, Card: 'Card', Row: 'Row', Btn: 'Btn', Switch: 'Switch', Seg: 'Seg', Range: 'Range', ListArea: 'ListArea', Empty: 'Empty',
    ImportPersona: 'ImportPersona', PersonaBindings: 'PersonaBindings', AvatarCard: 'AvatarCard', PolishLayer: 'PolishLayer', PersonaRvc: 'PersonaRvc', PersonaReferences: 'PersonaReferences', LegacyPersonaEditor: 'LegacyPersonaEditor', EffectivePrompt: 'EffectivePrompt', PersonaPreview: 'PersonaPreview', PersonaRevision: 'PersonaRevision',
    PROACTIVITY: [], ORIGIN: {}, cx: (...x) => x.filter(Boolean).join(' '), clone: structuredClone, setPath, getPath: (o, path) => path.split('.').reduce((v, k) => v?.[k], o),
    useState: v => { const i = stateIndex++; if (!(i in states)) states[i] = v; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }] },
    useRef: v => { const i = refIndex++; return refs[i] || (refs[i] = { current: v }) }, useEffect() {}, confirm: () => true,
    get: async () => ({ ok: true, list: states[0], bindings: [] }), post: async (path, body) => { calls.push({ path, body: plain(body) }); return { ok: true, persona: { ...card, editRevision: 2, draft: { layers: body.layers } } } } }
  runInNewContext(code + '\nglobalThis.render=Persona', ctx)
  const render = () => { stateIndex = 0; refIndex = 0; return ctx.render({ st: { config: { persona: { current: 'fish' } } }, toast() {}, reload() {} }) }
  const all = root => { const out = []; const walk = n => { if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach(walk) } }; walk(root); return out }
  all(render()).find(n => n.type === 'LegacyPersonaEditor').props.onChange('【身份】\r\n更新\r\n')
  assert.equal(states[6].layers.legacy.body, '【身份】\r\n更新\r\n'); assert.deepEqual(plain(states[6].layers.appearance), layers.appearance)
  assert.equal(states[7], true); assert.deepEqual(calls, [])
  await all(render()).find(n => n.type === 'Btn' && n.children.includes('存草稿')).props.onClick()
  assert.deepEqual(calls.map(call => call.path), ['/persona/draft'])
  assert.equal(calls[0].body.layers.legacy.body, '【身份】\r\n更新\r\n'); assert.deepEqual(calls[0].body.layers.appearance, layers.appearance)
})
