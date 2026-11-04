/* Scoped Vetro access runs in this widget, whose OS app identity is verified by Vetro. */
(function () {
  'use strict';
  var GH = window.GH, D = GH.data, legacyApps = D.vetroApps, legacyLaunch = D.vetroLaunch;
  if (!window.tizen || !window.tizen.messageport || !window.VetroAppAccess || GH.config.preview) return;
  var client = null, queue = Promise.resolve(), known = false;
  var P = GH.vetroPermissions = { busy: false, state: 'unknown', scopes: [] };
  function call(method, params) {
    var next = queue.then(function () {
      if (!client) client = new window.VetroAppAccess({ tizen: window.tizen,
        httpReplies: true, crypto: window.crypto, pollReply: D.vetroReply });
      return client.call(method, params);
    });
    queue = next.catch(function () {});
    return next;
  }
  function absent(e) { return !known && e && e.name === 'NotFoundError' && e.submitted === false; }
  function remember(status) {
    if (!status || !Array.isArray(status.scopes)) throw new Error('Invalid permission status');
    known = true; P.state = status.state; P.scopes = status.scopes.slice();
    return status;
  }
  function error(e) {
    P.state = e && e.code || 'unavailable'; P.scopes = [];
    var messages = {
      disabled: 'Turn on App access in Vetro’s App permissions, then choose Connect to Vetro.',
      permission_denied: 'Choose Connect to Vetro, approve its requested access in Vetro, then Refresh apps.',
      unavailable: 'Verified Vetro access is unavailable. Open Vetro and check App permissions.',
      identity_changed: 'Glass Home changed. Request access again and approve its new identity in Vetro.',
      timeout: 'Vetro did not reply. Open Vetro and try Refresh apps.'
    };
    return { available: false, apps: [], error: { code: P.state, message: messages[P.state] || 'Open Vetro and check App permissions.' } };
  }
  P.connect = function () {
    if (P.busy) return Promise.reject(new Error('A Vetro request is already pending.'));
    P.busy = true;
    return call('access.request', { scopes: ['apps.read', 'apps.launch'] }).then(function (result) {
      known = true; P.state = result.state;
      P.scopes = Array.isArray(result.scopes) ? result.scopes.slice() : [];
      return result.state === 'approved' ? 'Access is approved. Refreshing apps…' : 'In Vetro, open App permissions, refresh requests and approve Glass Home. Then Refresh apps here.';
    }).catch(function (e) { var result = error(e); throw new Error(result.error.message); }).then(function (message) {
      P.busy = false; return message;
    }, function (e) { P.busy = false; throw e; });
  };
  P.description = function () {
    if (P.state === 'pending') return 'Waiting for approval in Vetro · then Refresh apps';
    if (P.state === 'approved') return P.scopes.indexOf('apps.launch') >= 0
      ? 'Vetro app list and coordinated launch approved'
      : 'App list approved · coordinated launch needs separate approval';
    return 'Vetro permissions: ' + P.state;
  };
  D.vetroApps = function (refresh) {
    return call('access.status', {}).then(function (status) {
      remember(status);
      if (P.scopes.indexOf('apps.read') < 0) return error({ code: 'permission_denied' });
      var entries = [], pages = 0;
      function page(offset) {
        return call('apps.list', { offset: offset, limit: 20 }).then(function (result) {
          if (!result || !Array.isArray(result.apps) || result.apps.length > 20) throw new Error('Invalid app page');
          result.apps.forEach(function (a) {
            if (a && a.disabled === false && typeof a.appId === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(a.appId) && typeof a.name === 'string')
              entries.push({ appId: a.appId, label: a.name.slice(0,120) });
          });
          pages++;
          if (result.nextOffset !== null && pages < 5) {
            if (typeof result.nextOffset !== 'number' || result.nextOffset !== offset + 20) throw new Error('Invalid app cursor');
            return page(result.nextOffset);
          }
          return { available: true, apps: entries, transport: 'permissions', error: entries.length ? null : { code: 'empty', message: 'No eligible visible apps.' } };
        });
      }
      return page(0);
    }).catch(function (e) {
      // Older Vetro may have no public port. Never fall back on a denial or a lost reply.
      if (absent(e)) { P.state = 'legacy'; return legacyApps(refresh); }
      return error(e);
    });
  };
  D.vetroLaunch = function (appId) {
    if (P.state === 'legacy' && !known) return legacyLaunch(appId);
    return call('apps.launch', { appId: appId }).then(function (result) {
      if (result && result.ok === true && result.submitted === true && result.appId === appId) return true;
      var e = new Error('Launch was not confirmed. Check the TV before trying again.');
      e.launchUnconfirmed = true; throw e;
    }, function (e) {
      // Only a verified refusal before dispatch permits the native fallback.
      if (e.submitted === false && ['disabled','permission_denied','not_allowed','identity_changed','unavailable'].indexOf(e.code) >= 0) return false;
      e.launchUnconfirmed = true; throw e;
    });
  };
}());
