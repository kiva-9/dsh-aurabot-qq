import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const source=readFileSync(new URL('../client/client.js',import.meta.url),'utf8')

test('settings panel renders scoped controls and edits policy without sending requests',()=>{
  const code=source.slice(source.indexOf('    function NewFeatures('),source.indexOf('    // ---------------- 面板主体'))
  const calls=[], states=[], fields=[], nodes=[]; let cursor=0, draft={botQQ:'1',ownerQQ:'2',persona:{current:'p'},crossChatHistory:[]}
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)})
  const ctx={h,Card:'Card',Row:'Row',Btn:'Btn',Switch:'Switch',URLSearchParams,API:'/fake',
    useState:v=>{const i=cursor++;if(!(i in states))states[i]=v;return [states[i],x=>states[i]=x]},
    useRef:v=>({current:v}),useEffect:()=>{},
    useField:()=>new Proxy({},{get:(_,kind)=>(path)=>{fields.push(path);return h('Field',{path,kind})}}),
    clone:structuredClone,setPath:(o,path,v)=>({...o,[path]:v}),get:async p=>{calls.push(p);return {ok:true}},post:async p=>{calls.push(p);return {ok:true}}}
  runInNewContext(code+'\nglobalThis.render=NewFeatures',ctx)
  const tree=ctx.render({draft,setDraft:v=>{draft=v},toast:()=>{}})
  const walk=n=>{if(!n||typeof n!=='object')return;nodes.push(n);(n.children||[]).forEach(walk)};walk(tree)
  for(const path of ['incomingFiles.enabled','group.ignoreAtOthers','ignoredSenderQQs','conversation.seedHistory','approvalNotify','stickers.collectMode','voice.rvc.enabled','speakUp.targets','speakUp.mode','bili.visionEnabled','bili.danmakuEnabled']) assert.ok(fields.includes(path),path)
  assert.deepEqual(calls,[])
  const add=nodes.find(n=>n.type==='Btn'&&n.children.includes('＋ 添加策略'));add.props.onClick()
  assert.equal(draft.crossChatHistory.length,1);assert.equal(draft.crossChatHistory[0].enabled,false)
})

test('navigation and polish expose explicit preview before applying changes',()=>{
  assert.match(source,/搜索页面（Alt\+K）/)
  assert.match(source,/e\.altKey.*e\.key\.toLowerCase\(\) === 'k'/)
  assert.match(source,/post\('\/persona\/polish',\{text:original,section:section\.split/)
  assert.match(source,/采用到草稿/)
  assert.match(source,/setCandidate\(r\.text\)/)
})

test('polish suggestions require an explicit choice and cannot replace edited text', async () => {
  const code = source.slice(source.indexOf('    function PolishLayer('), source.indexOf('    function Persona('))
  const states = [], calls = [], chosen = []; let cursor = 0
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) })
  const ctx = { h, Btn: 'Btn', useState: v => { const i = cursor++; if (!(i in states)) states[i] = v; return [states[i], x => { states[i] = x }] },
    post: async (path, body) => { calls.push({ path, body }); return { ok: true, text: '润色建议' } } }
  runInNewContext(code + '\nglobalThis.render=PolishLayer', ctx)
  const render = text => { cursor = 0; return ctx.render({ section: 'identity.core', text, onChoose: v => chosen.push(v), toast() {} }) }
  const all = root => { const out = []; const walk = n => { if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach(walk) } }; walk(root); return out }
  await all(render('原文')).find(n => n.type === 'Btn' && n.children.includes('AI 润色此层')).props.onClick()
  assert.deepEqual(chosen, []); assert.equal(calls[0].body.section, 'identity')
  const stale = all(render('后来修改')).find(n => n.type === 'Btn' && n.children.includes('采用到草稿'))
  assert.equal(stale.props.disabled, true)
  const apply = all(render('原文')).find(n => n.type === 'Btn' && n.children.includes('采用到草稿'))
  assert.equal(apply.props.disabled, false); apply.props.onClick(); assert.deepEqual(chosen, ['润色建议'])
})

test('persona edits made during draft saving survive and prevent publishing stale content', async () => {
  const code = source.slice(source.indexOf('    function Persona('), source.indexOf('    function EffectivePrompt('))
  const layers = { identity: { name: 'Fish', callOwner: '', core: '原文' }, behavior: { proactivity: 'normal', text: '' },
    style: { text: '', examples: [], banned: [] }, appearance: { text: '', referenceAssetIds: [] }, voice: { voice: '', speed: 1 },
    policy: {}, tags: [] }
  const card = { id: 'fish', name: 'Fish', editRevision: 1, draft: { layers }, published: null }
  const state = [[{ id:'fish', name:'Fish', tags:[], origin:'user', revision:0 }], [], false, 'fish', card, [], { name:'Fish', layers: structuredClone(layers) }, true, 'edit', null]
  const refs = [], calls = []; let stateIndex = 0, refIndex = 0, finish
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) })
  const setPath = (o, path, v) => { const x = structuredClone(o), keys = path.split('.'); let cur = x; for (const key of keys.slice(0,-1)) cur = cur[key]; cur[keys.at(-1)] = v; return x }
  const ctx = { h, Card:'Card', Row:'Row', Btn:'Btn', Switch:'Switch', Seg:'Seg', Range:'Range', ListArea:'ListArea', Empty:'Empty',
    ImportPersona:'ImportPersona', PersonaBindings:'PersonaBindings', AvatarCard:'AvatarCard', PolishLayer:'PolishLayer', PersonaRvc:'PersonaRvc', EffectivePrompt:'EffectivePrompt', PersonaPreview:'PersonaPreview', PersonaRevision:'PersonaRevision',
    PROACTIVITY:[], ORIGIN:{}, cx:(...x)=>x.filter(Boolean).join(' '), clone:structuredClone, setPath, getPath:(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o),
    useState: v => { const i=stateIndex++; if (!(i in state)) state[i]=v; return [state[i], x => { state[i] = typeof x === 'function' ? x(state[i]) : x }] },
    useRef: v => { const i=refIndex++; return refs[i] || (refs[i] = { current:v }) }, useEffect() {}, confirm:()=>true,
    get: async () => ({ ok:true, list:state[0], bindings:[] }),
    post: (path, body) => { calls.push({path,body}); return new Promise(resolve => { finish = resolve }) } }
  runInNewContext(code+'\nglobalThis.render=Persona',ctx)
  const render=()=>{stateIndex=0;refIndex=0;return ctx.render({st:{config:{persona:{current:'fish'}}},toast(){},reload(){}})}
  const all=root=>{const out=[];const walk=n=>{if(n&&typeof n==='object'){out.push(n);(n.children||[]).forEach(walk)}};walk(root);return out}
  const publish=all(render()).find(n=>n.type==='Btn'&&n.children.includes('发布'))
  const pending=publish.props.onClick()
  const editor=all(render()).find(n=>n.type==='textarea'&&String(n.props.placeholder||'').startsWith('身份'))
  editor.props.onChange({target:{value:'保存期间的新编辑'}})
  finish({ok:true,persona:{...card,editRevision:2}})
  await pending
  assert.equal(state[6].layers.identity.core,'保存期间的新编辑')
  assert.equal(state[7],true)
  assert.deepEqual(calls.map(c=>c.path),['/persona/draft'])
})

test('persona RVC overrides can be set and removed without overwriting other voice settings', () => {
  const code=source.slice(source.indexOf('    function PersonaRvc('),source.indexOf('    function Persona('))
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)})
  const ctx={h,Row:'Row',Select:'Select'}
  runInNewContext(code+'\nglobalThis.render=PersonaRvc',ctx)
  let voice={voice:'base',speed:1}; const render=()=>ctx.render({voice,onChange:v=>{voice=v}})
  const row=(tree,label)=>tree.children.find(n=>n.type==='Row'&&n.props.label===label)
  let tree=render(); row(tree,'RVC 模式').children[0].props.onChange('off')
  assert.equal(voice.rvc.enabled,false)
  tree=render(); row(tree,'RVC 音高').children[0].props.onChange({target:{value:'0'}})
  assert.equal(voice.rvc.pitch,0)
  tree=render(); row(tree,'RVC 模式').children[0].props.onChange('')
  assert.equal('enabled' in voice.rvc,false)
  tree=render(); row(tree,'RVC 音高').children[0].props.onChange({target:{value:''}})
  assert.equal('rvc' in voice,false); assert.equal(voice.voice,'base'); assert.equal(voice.speed,1)
})

test('Bili screenshot source shows frame and requested times with extraction method', () => {
  const code=source.slice(source.indexOf('    function screenshotSource('),source.indexOf('    function NewFeatures('))
  const ctx={}; runInNewContext(code+'\nglobalThis.format=screenshotSource',ctx)
  assert.equal(ctx.format(JSON.stringify({part:2,partTitle:'片段',method:'preview',seconds:65,requestedSeconds:70})), 'P2 片段 · 预览图抽帧 · 画面 1:05 · 请求 1:10')
  assert.equal(ctx.format('{broken'),'来源信息不可用')
})

test('Bili panel exposes separate optional owner identity controls', () => {
  const code=source.slice(source.indexOf('    function Bili('),source.indexOf('// ---------------- 生图：'))
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)})
  const fields=[]
  const ctx={h,Card:'Card',Row:'Row',Btn:'Btn',BiliCookie:'BiliCookie',Empty:'Empty',Fragment:'Fragment', BILI_KIND:{},
    useState:v=>[v,()=>{}],useEffect:()=>{}, useField:()=>new Proxy({},{get:(_,kind)=>(path)=>{fields.push(path);return h('Field',{kind,path})}})}
  runInNewContext(code+'\nglobalThis.render=Bili',ctx)
  ctx.render({draft:{bili:{}},setDraft(){},toast(){}})
  assert.ok(fields.includes('bili.ownerName')); assert.ok(fields.includes('bili.ownerMid')); assert.ok(!fields.includes('ownerName'))
})
