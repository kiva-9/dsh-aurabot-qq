import {test} from 'node:test'
import assert from 'node:assert/strict'
import {probeHost} from '../src/runtime/host-contract.js'
test('host probe falls back to explicit Cordis service lookup when a property getter refuses access',()=>{
 const service={create(){},resolveAgent(){},cancel(){},selectModel(){}}
 const ctx={get:name=>name==='sessionController'?service:null}
 Object.defineProperty(ctx,'sessionController',{get(){throw new Error('undeclared dependency property')}})
 const result=probeHost(ctx);assert.equal(result.caps.sessionController,true);assert.equal(result.caps['controller.cancel'],true)
})
