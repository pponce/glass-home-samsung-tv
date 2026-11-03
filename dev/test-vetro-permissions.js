#!/usr/bin/env node
'use strict';
const assert = require('assert').strict, fs = require('fs'), vm = require('vm'), path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../app/js/vetro-permissions.js'), 'utf8');
const copy = v => JSON.parse(JSON.stringify(v));
function setup(reply, {messageport = {}, preview = false} = {}) {
  const calls = [], legacy = [], GH = {config: {preview}, data: {
    vetroApps: async refresh => {legacy.push(['apps',refresh]); return {available:true, apps:[{appId:'old.Netflix',label:'Netflix'}]};},
    vetroLaunch: async id => {legacy.push(['launch',id]); return true;}
  }};
  const window = {GH,tizen:{messageport},VetroAppAccess:function () {
    this.call = (method, params) => {calls.push([method,copy(params)]);return Promise.resolve().then(()=>reply(method,params));};
  }};
  vm.runInNewContext(source, {window,Promise});
  return {GH,calls,legacy};
}
const refusal = (code, submitted = false) => Object.assign(Error(code), {code,submitted});
const missing = () => {throw Object.assign(Error('missing'),{name:'NotFoundError',submitted:false});};
(async () => {
  let s = setup(missing);
  assert.equal((await s.GH.data.vetroApps(true)).available,true);
  assert.equal(await s.GH.data.vetroLaunch('old.Netflix'),true);
  assert.deepEqual(s.legacy,[['apps',true],['launch','old.Netflix']]);
  s = setup(missing,{messageport:null});
  assert.equal(s.GH.vetroPermissions,undefined);
  await s.GH.data.vetroApps(false); await s.GH.data.vetroLaunch('old.Netflix');
  assert.equal(s.legacy.length,2);assert.equal(s.calls.length,0);
  for (const code of ['disabled','permission_denied','unavailable','identity_changed','timeout']) {
    s = setup(()=>{throw refusal(code,code==='timeout'?null:false);});
    assert.equal((await s.GH.data.vetroApps()).available,false); assert.equal(s.legacy.length,0);
    assert.equal(s.calls[0][0],'access.status'); // Passive refresh must not request new permissions.
  }
  let scopes = ['apps.read','apps.launch'], reply = null;
  s = setup((method,params)=> {
    if(method==='access.request') {assert.deepEqual(copy(params.scopes),['apps.read','apps.launch']);return {state:'pending'};}
    if(method==='access.status') return {state:'approved',scopes};
    if(method==='apps.list') return {apps:params.offset ? [{appId:'other.app',name:'Other',disabled:false}] : [{appId:'preload.Netflix',name:'Netflix',disabled:false},{appId:'disabled.app',name:'Disabled',disabled:true}], nextOffset:params.offset?null:20};
    if(method==='apps.launch') {if(reply) throw reply;return {ok:true,submitted:true,appId:params.appId};}
    throw Error(method);
  });
  assert.match(await s.GH.vetroPermissions.connect(),/approve Glass Home/);
  const list=await s.GH.data.vetroApps();assert.deepEqual(copy(list.apps),[{appId:'preload.Netflix',label:'Netflix'},{appId:'other.app',label:'Other'}]);
  assert.equal(await s.GH.data.vetroLaunch('preload.Netflix'),true);
  for(const submitted of [null,true,undefined]) {
    reply=refusal('permission_denied',submitted);if(submitted===undefined)delete reply.submitted;
    await assert.rejects(s.GH.data.vetroLaunch('preload.Netflix'),e=>e.launchUnconfirmed===true);
  }
  reply=refusal('permission_denied');assert.equal(await s.GH.data.vetroLaunch('preload.Netflix'),false);
  assert.equal(s.legacy.length,0);
  scopes=['apps.read'];reply=null;await s.GH.data.vetroApps();assert.match(s.GH.vetroPermissions.description(),/separate approval/);
  scopes=['apps.launch'];const before=s.calls.filter(c=>c[0]==='apps.list').length;
  assert.equal((await s.GH.data.vetroApps()).available,false);
  assert.equal(s.calls.filter(c=>c[0]==='apps.list').length,before,'do not read apps when only launch approved');
  // Once the new protocol answered, a disappearing port cannot downgrade to legacy HTTP.
  s=setup((method)=>method==='access.status'?{state:'approved',scopes:['apps.read']}:missing());
  assert.equal((await s.GH.data.vetroApps()).available,false);assert.equal(s.legacy.length,0);
  // Check compatibility using the real copied SDK's missing-remote error, not only a mock error.
  const SDK=require('../app/js/vetro-access-client.js');
  const mp={requestLocalMessagePort:()=>({addMessagePortListener:()=>1,removeMessagePortListener:()=>{}}),requestRemoteMessagePort:()=>{throw Object.assign(Error('not running'),{name:'NotFoundError'});}};
  const client=new SDK({tizen:{messageport:mp}});
  await assert.rejects(client.call('access.status',{}),e=>e.name==='NotFoundError'&&e.submitted===false);client.close();
  console.log('PASS Vetro permissions: legacy app list/launch, no-port TVs, explicit scopes, partial approval, pagination, denial/timeout isolation, no duplicate launches');
})().catch(e=>{console.error(e);process.exitCode=1;});
