#!/usr/bin/env node
'use strict';
const assert=require('assert').strict,fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const read=name=>fs.readFileSync(path.join(__dirname,'../app/js',name),'utf8');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function crc(data){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function piece(type,data){const body=Buffer.concat([Buffer.from(type),data]),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([n,body,sum]);}
function png(extra=0){const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),piece('IHDR',header),piece('tEXt',Buffer.from('fixture\0'+'x'.repeat(extra))),piece('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0,255]))),piece('IEND',Buffer.alloc(0))]);}
const small=png(),large=png(19000),url='data:image/png;base64,'+small.toString('base64');
function response(data,p){const end=Math.min(data.length,p.offset+8192);return {appId:p.appId,mimeType:'image/png',revision:hash(data),offset:p.offset,totalBytes:data.length,data:data.subarray(p.offset,end).toString('base64'),nextOffset:end<data.length?end:null};}
function transport(reply){
 const calls=[],timers=[],GH={config:{},data:{vetroApps:()=>{throw Error('Unexpected legacy read');}}};
 const window={GH,atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),sha256:require('../app/js/vendor/sha256'),tizen:{messageport:{}},VetroAppAccess:function(){this.call=(m,p)=>{calls.push([m,JSON.parse(JSON.stringify(p))]);return Promise.resolve().then(()=>reply(m,p));};}};
 vm.runInNewContext(read('vetro-permissions.js'),{window,Promise,setTimeout:(fn,ms)=>{timers.push(ms);return setTimeout(fn,0);}});
 GH.vetroPermissions.scopes=['apps.read','apps.launch'];return {GH,calls,timers};
}
function dock(stored={},loader=()=>Promise.resolve(url)){
 const calls=[],GH={config:{apps:[{key:'prime',label:'Prime Video',ids:['org.tizen.primevideo'],icon:false},{key:'youtube',label:'YouTube',ids:['com.samsung.tv.cobalt-yt'],icon:false}]},
  ls:{get:k=>stored[k],set:(k,v)=>{stored[k]=JSON.parse(JSON.stringify(v));}},data:{vetroIcon:(id,current)=>{calls.push(id);return loader(id,current);}}};
 vm.runInNewContext(read('vetro-apps.js'),{window:{GH},Promise});
 const V=GH.vetro;V.available=true;V.iconSupport=true;V.source='samsung-apps';V.preferencesReady=true;
 V.entries=[{appId:'org.tizen.netflix-app',label:'Netflix',homeOrder:0},{appId:'org.tizen.primevideo',label:'Prime Video',homeOrder:1},{appId:'com.samsung.tv.cobalt-yt',label:'YouTube',homeOrder:2}];
 return {V,GH,calls,stored};
}
(async()=>{
 let t=transport((m,p)=>{assert.equal(m,'apps.icon');if(p.offset)assert.equal(p.revision,hash(large));return response(large,p);});
 assert.equal(await t.GH.data.vetroIcon('com.samsung.tv.cobalt-yt'),'data:image/png;base64,'+large.toString('base64'));
 assert.deepEqual(t.calls.map(c=>c[1].offset),[0,8192,16384]);assert.ok(t.timers.length>=2,'icon requests share the global request pacing');
 t=transport((m,p)=>({appId:p.appId,icon:null}));assert.equal(await t.GH.data.vetroIcon('media.app'),null);
 for(const mutate of [r=>r.appId='other.app',r=>r.mimeType='image/svg+xml',r=>r.totalBytes=131073,r=>r.revision='0'.repeat(64),
     r=>r.nextOffset=0,r=>r.offset=1,r=>r.data='not base64',r=>r.data=r.data.slice(0,-4)]){
   t=transport((m,p)=>{const r=response(small,p);mutate(r);return r;});
   await assert.rejects(t.GH.data.vetroIcon('media.app'));
 }
 t=transport((m,p)=>{const r=response(large,p);if(p.offset)r.revision='1'.repeat(64);return r;});
 await assert.rejects(t.GH.data.vetroIcon('media.app'),/changed/);
 t=transport(()=>{throw Object.assign(Error('revoked'),{code:'permission_denied'});});
 await assert.rejects(t.GH.data.vetroIcon('media.app'),e=>e.code==='permission_denied');
 assert.equal(t.calls.length,1,'a permission failure never falls back or retries');
 t=transport(()=>{throw Error('must not send');});
 await assert.rejects(t.GH.data.vetroIcon('../private'));assert.equal(t.calls.length,0);
 await assert.rejects(t.GH.data.vetroIcon('media.app',()=>false),e=>e.code==='cancelled');assert.equal(t.calls.length,0);

 // A launch enters the shared queue before the next image chunk.
 let first; t=transport((m,p)=>m==='apps.launch'?{ok:true,submitted:true,appId:p.appId}:p.offset?response(large,p):new Promise(r=>{first=()=>r(response(large,p));}));
 const loading=t.GH.data.vetroIcon('media.app');while(!first)await new Promise(setImmediate);
 const launching=t.GH.data.vetroLaunch('other.app');first();
 assert.equal(await launching,true);await loading;
 assert.deepEqual(t.calls.slice(0,3).map(c=>c[0]),['apps.icon','apps.launch','apps.icon']);

 let d=dock(),painted=0;const defs=d.V.definitions();
 assert.equal(d.V.iconFor(defs[1],'file:///bad.png'),null);
 await d.V.loadIcons(()=>painted++);
 assert.deepEqual(d.calls,['org.tizen.primevideo','com.samsung.tv.cobalt-yt','org.tizen.netflix-app'],'name-only tiles are filled first');
 assert.equal(painted,3);assert.equal(d.V.iconFor(defs[1],'file:///bad.png'),url);
 assert.equal(d.V.iconFor({...defs[1],icon:'img/custom.png'},null),'img/custom.png','custom artwork stays authoritative');
 await d.V.loadIcons();assert.equal(d.calls.length,3,'ordinary refreshes do not redownload each image');
 const reopened=dock(d.stored);assert.equal(reopened.V.iconFor(reopened.V.definitions()[1],null),url,'cache supplies icons immediately after reopen');
 d=dock({'gh.vetro.icons.v1':[{appId:'org.tizen.primevideo',url:'data:image/svg+xml,<svg/>',at:Date.now()}]});
 assert.equal(d.V.iconFor(d.V.definitions()[1],null),null,'untrusted cache cannot introduce SVG or arbitrary URLs');
 d=dock({},()=>Promise.resolve(null));await d.V.loadIcons();assert.equal(d.V.iconFor(d.V.definitions()[1],null),null);
 d=dock({},()=>Promise.reject(Object.assign(Error('revoked'),{code:'permission_denied'})));await d.V.loadIcons();
 assert.equal(d.calls.length,1);assert.equal(d.V.iconSupport,false,'permission failure stops the background pass');
 d=dock();d.V.iconSupport=false;await d.V.loadIcons();assert.equal(d.calls.length,0,'older Vetro is not asked for unsupported artwork');
 d=dock();await d.V.loadIcons(null,()=>false);assert.equal(d.calls.length,0,'a hidden Glass Home does not download icons');
 d=dock();d.V.hidden=['prime'];await d.V.loadIcons();assert.ok(!d.calls.includes('org.tizen.primevideo'),'hidden apps are not downloaded');
 console.log('PASS Vetro icons: authenticated chunk validation, digest, pacing, launch interleaving, cancellation, cache, defaults, fallback and revocation');
})().catch(e=>{console.error(e);process.exitCode=1;});
