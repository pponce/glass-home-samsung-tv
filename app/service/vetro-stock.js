// Fixed stock Vetro endpoints on this TV; no owner credential or remote host input.
'use strict';
var http = require('http'), legacy = require('./vetro');
var ID = /^[A-Za-z0-9_.-]{1,120}$/;
function request(address, route, binary) {
  return new Promise(function (resolve, reject) {
    var req, done = false, timer = setTimeout(function () { finish(Error('Vetro timed out')); }, 25000);
    function finish(error, result) { if (done) return; done = true; clearTimeout(timer); if (error) { reject(error); if(req)req.destroy(); } else resolve(result); }
    try {
      req = http.request({hostname:address,localAddress:address,family:4,port:8099,path:route,method:'GET',agent:false,
        headers:{Accept:binary?'image/png, image/jpeg':'application/json',Connection:'close'}},function(res){
        if(res.statusCode!==200)return finish(Object.assign(Error('Vetro returned HTTP '+res.statusCode),{status:res.statusCode}));
        var chunks=[],size=0;
        res.on('data',function(b){size+=b.length;if(size>(binary?131072:2*1024*1024))return finish(Error('Vetro response too large'));chunks.push(b);});
        res.on('error',finish);res.on('aborted',function(){finish(Error('Vetro response interrupted'));});
        res.on('end',function(){if(done)return;try{var b=Buffer.concat(chunks);finish(null,binary?b:JSON.parse(b.toString('utf8')));}catch(e){finish(e);}});
      });req.on('error',finish);req.end();
    }catch(e){finish(e);}
  });
}
function catalog(data,home,self) {
  if(!data||data.registryError||!Array.isArray(data.apps)||data.apps.length>2000)throw Error('Installed app registry unavailable');
  var order=Object.create(null),seen=Object.create(null);
  (home.apps||[]).forEach(function(a,i){if(i<300)order[a.appId]=i;});
  return data.apps.filter(function(a){
    if(!a||typeof a.appId!=='string'||!ID.test(a.appId)||a.show!==true||a.disabled!==false||a.launchRisk||a.appId==='org.tizen.tv-viewer'||
       a.appId===self||a.appId.indexOf(self+'.')===0||/^vetrotvapp(?:\.|$)/.test(a.appId)||seen[a.appId]||typeof a.name!=='string'||!a.name.trim())return false;
    seen[a.appId]=true;return true;
  }).map(function(a){return {appId:a.appId,label:a.name.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,120),homeOrder:order[a.appId]===undefined?null:order[a.appId]};})
    .sort(function(a,b){return (a.homeOrder===null?9999:a.homeOrder)-(b.homeOrder===null?9999:b.homeOrder)||a.label.localeCompare(b.label);});
}
function image(b){
  if(!Buffer.isBuffer(b)||b.length<24||b.length>131072)return null;
  var mime=b.slice(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217?'image/jpeg':null;
  if(mime==='image/png'&&(b.toString('ascii',12,16)!=='IHDR'||!b.readUInt32BE(16)||!b.readUInt32BE(20)||b.readUInt32BE(16)>2048||b.readUInt32BE(20)>2048))return null;
  return mime?'data:'+mime+';base64,'+b.toString('base64'):null;
}
function createReader(self,onError,options){
  options=options||{};var readHome=options.readHome||legacy.readApps,get=options.request||request,cached=null,pending=null,at=0,slugs={};
  function read(refresh){
    if(!refresh&&cached&&Date.now()-at<30000)return Promise.resolve(cached);
    if(!pending)pending=readHome(self).then(function(home){
      if(!home.address)throw Error('Vetro address unavailable');
      return Promise.all([get(home.address,'/apps'+(refresh?'?refresh=1':'')),get(home.address,'/dock')]).then(function(both){
        var apps=catalog(both[0],home,self);slugs={};
        (both[1].entries||[]).forEach(function(e){if(e&&!e.system&&!e.panel&&!e.source&&/^[A-Za-z0-9_.-]{1,120}$/.test(e.slug))slugs[e.appId]=e.slug;});
        return {available:true,apps:apps,address:home.address,source:'samsung-apps',transport:'stock',iconSupport:true};
      });
    }).catch(function(e){var error=e.vetro||{code:e.status?'http':'stock',message:e.message};if(e.status)error.status=e.status;if(onError)onError(error);return {available:false,apps:[],error:error};}).then(function(result){cached=result;at=Date.now();pending=null;return result;});
    return pending;
  }
  read.current=function(){return cached;};
  read.icon=function(id){
    var c=cached;
    if(!ID.test(id)||!c||!c.available||!c.apps.some(function(a){return a.appId===id;}))return Promise.reject(Error('App not in current catalog'));
    if(c.address!=='127.0.0.1'&&legacy.localLanAddresses().indexOf(c.address)<0)return Promise.reject(Error('TV address changed'));
    function packageIcon(){return get(c.address,'/apps/icon?appId='+encodeURIComponent(id),true).then(image).catch(function(e){if(e.status===404)return null;throw e;});}
    if(!slugs[id])return packageIcon();
    return get(c.address,'/dock/icon?slug='+encodeURIComponent(slugs[id]),true).then(function(b){return image(b)||packageIcon();}).catch(function(e){if(e.status===404)return packageIcon();throw e;});
  };
  return read;
}
module.exports={createReader:createReader,catalog:catalog,image:image};
