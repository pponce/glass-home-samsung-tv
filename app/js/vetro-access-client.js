/* Vetro app access. HTTP replies are opt-in and require vendor/sha256.js in browsers. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root, function(){return require('./vendor/sha256.js');});
    else root.VetroAppAccess = factory(root, function(){return root.sha256;});
}(this, function (root, hashProvider) {
    'use strict';
    var MAX_BODY=16384,MAX_FRAME=36864;
    function bytes(text){return encodeURIComponent(text).replace(/%[A-F\d]{2}/g,'x').length;}
    function hex(data,start,end){var out='';for(var i=start;i<end;i++)out+=('0'+data[i].toString(16)).slice(-2);return out;}
    function fault(message,code,submitted){var e=Error(message);e.code=code;e.submitted=submitted;return e;}
    function cleanup(client,id) {
        var p=client.pending[id];if(!p)return null;
        delete client.pending[id];clearTimeout(p.timer);clearTimeout(p.pollTimer);
        if(p.secret)for(var i=0;i<p.secret.length;i++)p.secret[i]=0;
        return p;
    }
    function fail(client,id,error){var p=cleanup(client,id);if(p)p.reject(error);}
    function received(client,id,message) {
        var p=cleanup(client,id);if(!p)return;
        if(message.ok)p.resolve(message.result);
        else p.reject(fault(message.error&&message.error.message||'Request refused',
            message.error&&message.error.code||'unavailable',
            message.error&&typeof message.error.submitted==='boolean'?message.error.submitted:null));
    }
    function invalid(){return fault('Vetro reply could not be authenticated. Check the current state before retrying.','invalid_reply',null);}
    function verify(client,id,frame) {
        var p=client.pending[id];
        if(!p)return;
        if(!frame||typeof frame!=='object'||Array.isArray(frame)||Object.keys(frame).length!==2||
            typeof frame.body!=='string'||frame.body.length>MAX_BODY||bytes(frame.body)>MAX_BODY||
            typeof frame.mac!=='string'||!/^[a-f0-9]{64}$/.test(frame.mac)||bytes(JSON.stringify(frame))>MAX_FRAME)throw invalid();
        // Authenticate the exact serialized body before parsing any result or refusal.
        var expected=client.hash.hmac(p.secret,'VETRO_APP_REPLY_V2\n'+p.replyId+'\n'+frame.body),difference=0;
        if(typeof expected!=='string'||expected.length!==64)throw invalid();
        for(var i=0;i<64;i++)difference|=expected.charCodeAt(i)^frame.mac.charCodeAt(i);
        if(difference)throw invalid();
        var message=JSON.parse(frame.body);
        if(!message||message.version!==2||message.id!==id||typeof message.ok!=='boolean')throw invalid();
        received(client,id,message);
    }
    function poll(client,id) {
        var p=client.pending[id];if(!p||client.closed)return;
        p.pollTimer=null;
        Promise.resolve().then(function(){
            if(client.pending[id]!==p||client.closed)return null;
            return client.pollReply(p.replyId);
        }).then(function(reply){
            if(client.pending[id]!==p||client.closed)return;
            if(reply&&(reply.status===202||reply.status===404)) {
                p.pollTimer=setTimeout(function(){poll(client,id);},250);return;
            }
            if(!reply||reply.status!==200)throw fault('Vetro reply could not be read. Check the current state before retrying.','reply_unavailable',null);
            try{verify(client,id,reply.body);}catch(_){throw invalid();}
        }).then(null,function(error){
            if(client.pending[id]!==p)return;
            fail(client,id,error&&error.code==='invalid_reply'?error:
                fault('Vetro reply could not be read. Check the current state before retrying.','reply_unavailable',null));
        });
    }
    function Client(options) {
        options=options||{};
        this.tizen=options.tizen || (typeof tizen !== 'undefined' ? tizen : null);
        this.trusted=options.widget===true;
        this.httpReplies=options.httpReplies===true&&!this.trusted;
        this.port=this.trusted?'VETRO_WIDGET_V1':'VETRO_APP_ACCESS_V1';
        this.replyPort=this.trusted?'VETRO_WIDGET_REPLY_V1':this.port;
        this.timeout=options.timeout||15000;
        if(this.httpReplies) {
            this.timeout=typeof this.timeout==='number'&&isFinite(this.timeout)&&this.timeout>0?Math.min(this.timeout,15000):15000;
            this.crypto=options.crypto||root.crypto;
            this.pollReply=options.pollReply;
            this.hash=hashProvider();
            if(!this.crypto||typeof this.crypto.getRandomValues!=='function'||typeof Uint8Array==='undefined'||
                typeof this.pollReply!=='function'||!this.hash||typeof this.hash.hmac!=='function')
                throw fault('Secure Vetro reply transport is unavailable.','unavailable',false);
        }
        this.pending=Object.create(null);this.sequence=0;this.closed=false;
        var self=this,mp=this.tizen&&this.tizen.messageport;
        if(!mp)throw Error('Tizen MessagePort is unavailable');
        var name='VETRO_REPLY_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
        // Authenticate the request destination through the trusted receiver. Use
        // regular return ports; response identity still comes from Tizen metadata.
        this.local=mp.requestLocalMessagePort(name);
        if(this.trusted&&this.local.isTrusted!==false)throw Error('Widget reply port unavailable');
        this.diagnostics=this.trusted&&typeof options.diagnostics==='function'?options.diagnostics(this):null;
        this.listener=this.local.addMessagePortListener(function(data,remote){
            // V2 results require the per-request MAC, even if a V1 reply has valid metadata.
            if(self.httpReplies)return;
            if(self.diagnostics)try{self.diagnostics.observe(data,remote);}catch(_){}
            if(!remote||remote.appId!=='vetrotvapp.svc'||remote.messagePortName!==self.replyPort||self.trusted&&remote.isTrusted!==false)return;
            var p;
            try {
                if(!Array.isArray(data)||data.length!==1||data[0].key!=='json'||typeof data[0].value!=='string'||data[0].value.length>16384)return;
                p=JSON.parse(data[0].value);
                if(!p||p.version!==1||typeof p.id!=='string'||typeof p.ok!=='boolean'||!self.pending[p.id])return;
            } catch(_){return;}
            received(self,p.id,p);
        });
    }
    Client.prototype.call=function(method,params){
        var self=this;
        return new Promise(function(resolve,reject){
            if(self.closed)return reject(Error('Vetro client is closed'));
            if(Object.keys(self.pending).length)return reject(Error('Wait for the current Vetro request to finish'));
            if(self.diagnostics)try{self.diagnostics.publish();}catch(_){}
            var id=String(++self.sequence),data,remote,sending=false,secret,replyId;
            try {
                var message={version:self.httpReplies?2:1,id:id,method:method,params:params||{}};
                if(self.httpReplies) {
                    var random=new Uint8Array(64);self.crypto.getRandomValues(random);
                    replyId=hex(random,0,32);secret=new Uint8Array(32);
                    for(var i=0;i<32;i++)secret[i]=random[i+32];
                    message.reply={id:replyId,key:hex(random,32,64)};
                    for(i=0;i<random.length;i++)random[i]=0;
                }
                data=JSON.stringify(message);
                if(bytes(data)>4096)throw Error('Request is too large');
                remote=self.tizen.messageport[self.trusted?'requestTrustedRemoteMessagePort':'requestRemoteMessagePort']('vetrotvapp.svc',self.port);
                if(self.trusted&&(!remote||remote.appId!=='vetrotvapp.svc'||remote.messagePortName!==self.port||remote.isTrusted!==true))throw Error('Trusted Vetro service unavailable');
                self.pending[id]={resolve:resolve,reject:reject,secret:secret,replyId:replyId,pollTimer:null,timer:setTimeout(function(){
                    fail(self,id,fault('No confirmation from Vetro. Read the current state before retrying.','timeout',null));
                },self.timeout)};
                sending=true;
                remote.sendMessage([{key:'json',value:data}],self.local);
                if(self.httpReplies)poll(self,id);
            } catch(e){cleanup(self,id);if(secret)for(var j=0;j<secret.length;j++)secret[j]=0;e.submitted=sending?null:false;reject(e);}
        });
    };
    Client.prototype.close=function(){
        var self=this;this.closed=true;
        Object.keys(this.pending).forEach(function(id){fail(self,id,fault('Vetro client closed','closed',null));});
        this.pending=Object.create(null);
        try{this.local.removeMessagePortListener(this.listener);}catch(_){}
    };
    return Client;
}));
