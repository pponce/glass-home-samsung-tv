/* Stock Vetro uses Glass Home's local service for app discovery and launch. */
(function(){
  'use strict';
  var GH=window.GH,P=GH.vetroPermissions={busy:false,state:'unknown',scopes:[]};
  P.connect=function(){if(P.busy)return Promise.reject(Error('A Vetro request is pending.'));P.busy=true;
    return GH.data.vetroApps(true).then(function(r){if(!r.available)throw Error(r.error&&r.error.message||'Open Vetro and try again.');P.state='connected';return 'Connected to Vetro. Refreshing apps…';})
      .then(function(r){P.busy=false;return r;},function(e){P.busy=false;P.state='unavailable';throw e;});};
  P.description=function(){return P.state==='connected'?'Connected to Vetro on this TV':'Connect to Vetro on this TV';};
}());
