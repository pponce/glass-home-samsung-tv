'use strict';
const assert=require('assert').strict,fs=require('fs');const stock=require('../app/service/vetro-stock');
(async()=>{
 const row=(id,extra={})=>({appId:id,name:id,show:true,disabled:false,...extra});
 const data={apps:[row('Unpinned'),row('Pinned'),row('Off',{disabled:true}),row('Factory',{launchRisk:'confirm'}),row('Bg',{show:false}),row('GlassHome1.UI'),row('vetrotvapp.ui')]};
 const calls=[],png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);let fail=false;
 const reader=stock.createReader('GlassHome1',null,{readHome:async()=>({address:'127.0.0.1',apps:[{appId:'Pinned'}]}),request:async(address,path)=>{
 calls.push(path);if(path.startsWith('/apps/icon'))return png;if(path.startsWith('/dock/icon'))throw Object.assign(Error(),{status:404});
 if(path==='/dock')return {entries:[{appId:'Pinned',slug:'pinned'}]};if(fail)throw Error('lost');return data;}});
 const result=await reader(true);assert.equal(result.source,'samsung-apps');assert.deepEqual(result.apps.map(a=>[a.appId,a.homeOrder]),[['Pinned',0],['Unpinned',null]]);
 assert.ok((await reader.icon('Pinned')).startsWith('data:image/png;'));assert.ok(calls.includes('/dock/icon?slug=pinned'));assert.ok(calls.includes('/apps/icon?appId=Pinned'));
 await assert.rejects(reader.icon('Off'));await assert.rejects(reader.icon('../exec'));assert.equal(stock.image(Buffer.from('<svg/>')),null);
 assert.throws(()=>stock.catalog({registryError:'missing',apps:[]},{},'GlassHome1'));fail=true;assert.equal((await reader(true)).available,false);await assert.rejects(reader.icon('Pinned'));
 assert.ok(!fs.readFileSync('app/index.html','utf8').includes('js/vetro-permissions.js'));assert.ok(fs.readFileSync('app/service/server.js','utf8').includes("require('./vetro-stock').createReader"));
 const refused=stock.createReader('GlassHome1',null,{readHome:async()=>{throw Object.assign(Error('Vetro returned HTTP 503.'),{vetro:{code:'http',status:503,message:'Vetro returned HTTP 503.'}});}});assert.equal((await refused(true)).error.status,503);
 console.log('PASS stock catalog: unpinned apps, filtering, icon fallback, stale/errors, UI wiring');
})().catch(e=>{console.error(e);process.exitCode=1;});
