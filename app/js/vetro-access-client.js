/* Vetro app access v1. Copy this file into the client app; no HTTP credentials are needed. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.VetroAppAccess = factory();
}(this, function () {
    'use strict';
    function Client(options) {
        options=options||{};
        this.tizen=options.tizen || (typeof tizen !== 'undefined' ? tizen : null);
        this.trusted=options.widget===true;
        this.port=this.trusted?'VETRO_WIDGET_V1':'VETRO_APP_ACCESS_V1';
        this.timeout=options.timeout||15000;
        this.pending=Object.create(null);this.sequence=0;this.closed=false;
        var self=this,mp=this.tizen&&this.tizen.messageport;
        if(!mp)throw Error('Tizen MessagePort is unavailable');
        var name='VETRO_REPLY_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
        this.local=mp[this.trusted?'requestTrustedLocalMessagePort':'requestLocalMessagePort'](name);
        this.listener=this.local.addMessagePortListener(function(data,remote){
            if(!remote||remote.appId!=='vetrotvapp.svc'||remote.messagePortName!==self.port||self.trusted&&remote.isTrusted!==true)return;
            var p;
            try {
                if(!Array.isArray(data)||data.length!==1||data[0].key!=='json'||typeof data[0].value!=='string'||data[0].value.length>16384)return;
                p=JSON.parse(data[0].value);
                if(!p||p.version!==1||typeof p.id!=='string'||typeof p.ok!=='boolean'||!self.pending[p.id])return;
            } catch(_){return;}
            var waiting=self.pending[p.id];delete self.pending[p.id];clearTimeout(waiting.timer);
            if(p.ok)waiting.resolve(p.result);
            else {var e=Error(p.error&&p.error.message||'Request refused');e.code=p.error&&p.error.code||'unavailable';e.submitted=p.error&&typeof p.error.submitted==='boolean'?p.error.submitted:null;waiting.reject(e);}
        });
    }
    Client.prototype.call=function(method,params){
        var self=this;
        return new Promise(function(resolve,reject){
            if(self.closed)return reject(Error('Vetro client is closed'));
            if(Object.keys(self.pending).length)return reject(Error('Wait for the current Vetro request to finish'));
            var id=String(++self.sequence),data,remote,sending=false;
            try {
                data=JSON.stringify({version:1,id:id,method:method,params:params||{}});
                if(encodeURIComponent(data).replace(/%[A-F\d]{2}/g,'x').length>4096)throw Error('Request is too large');
                remote=self.tizen.messageport[self.trusted?'requestTrustedRemoteMessagePort':'requestRemoteMessagePort']('vetrotvapp.svc',self.port);
                self.pending[id]={resolve:resolve,reject:reject,timer:setTimeout(function(){
                    delete self.pending[id];var e=Error('No confirmation from Vetro. Read the current state before retrying.');e.code='timeout';e.submitted=null;reject(e);
                },self.timeout)};
                sending=true;
                remote.sendMessage([{key:'json',value:data}],self.local);
            } catch(e){if(self.pending[id])clearTimeout(self.pending[id].timer);delete self.pending[id];e.submitted=sending?null:false;reject(e);}
        });
    };
    Client.prototype.close=function(){
        var self=this;this.closed=true;
        Object.keys(this.pending).forEach(function(id){var p=self.pending[id];clearTimeout(p.timer);p.reject(Error('Vetro client closed'));});
        this.pending=Object.create(null);
        try{this.local.removeMessagePortListener(this.listener);}catch(_){}
    };
    return Client;
}));
