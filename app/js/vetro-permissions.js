/* Scoped Vetro access runs in this widget, whose OS app identity is verified by Vetro. */
(function () {
  'use strict';
  var GH = window.GH, D = GH.data, legacyApps = D.vetroApps, legacyLaunch = D.vetroLaunch;
  if (!window.tizen || !window.tizen.messageport || !window.VetroAppAccess || GH.config.preview) return;
  var client = null, queue = Promise.resolve(), known = false, nextCall = 0, selfPackage = 'GlassHome1';
  try { selfPackage = window.tizen.application.getCurrentApplication().appInfo.packageId || selfPackage; } catch (e) { /* package default */ }
  var P = GH.vetroPermissions = { busy: false, state: 'unknown', scopes: [] };
  function call(method, params) {
    var next = queue.then(function () {
      var wait = Math.max(0, nextCall - Date.now());
      return wait ? new Promise(function (resolve) { setTimeout(resolve, wait); }) : null;
    }).then(function () {
      nextCall = Date.now() + 600;
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
      update_required: 'Update Vetro to a version with Samsung Apps catalog support, then Refresh apps.',
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
      var entries = [], seen = Object.create(null), total = null, revision = null, iconSupport = false;
      function page(offset) {
        return call('apps.catalog', { offset: offset, limit: 20 }).then(function (result) {
          if (!result || result.source !== 'samsung-apps' || !Array.isArray(result.apps) ||
              !Number.isInteger(result.total) || result.total < 0 || result.total > 2000 ||
              typeof result.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision) ||
              result.apps.length !== Math.min(20, result.total - offset)) throw new Error('Invalid app page');
          if (total === null) { total = result.total; revision = result.revision; iconSupport = result.iconSupport === true; }
          if (result.total !== total || result.revision !== revision || (result.iconSupport === true) !== iconSupport) throw new Error('App list changed. Refresh apps again.');
          var next = offset + result.apps.length;
          if (result.nextOffset !== (next < total ? next : null)) throw new Error('Invalid app cursor');
          result.apps.forEach(function (a) {
            if (!a || a.disabled !== false || typeof a.appId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(a.appId) || seen[a.appId] ||
                typeof a.name !== 'string' || !a.name.trim() || a.name.length > 120 ||
                !(a.homeOrder === null || Number.isInteger(a.homeOrder) && a.homeOrder >= 0 && a.homeOrder < 300)) throw new Error('Invalid app entry');
            seen[a.appId] = true;
            if (a.appId !== selfPackage && a.appId.indexOf(selfPackage + '.') !== 0)
              entries.push({ appId: a.appId, label: a.name, homeOrder: a.homeOrder });
          });
          if (result.nextOffset !== null) {
            return page(result.nextOffset);
          }
          return { available: true, apps: entries, source: 'samsung-apps', transport: 'permissions', iconSupport: iconSupport, error: null };
        }, function (e) {
          if (e && (e.code === 'invalid_request' || e.code === 'not_allowed')) e.code = 'update_required';
          throw e;
        });
      }
      return page(0);
    }).catch(function (e) {
      // Older Vetro may have no public port. Never fall back on a denial or a lost reply.
      if (absent(e)) { P.state = 'legacy'; return legacyApps(refresh); }
      return error(e);
    });
  };
  // Each image chunk stays inside the existing authenticated reply size limit.
  // Only one chunk is queued at a time, so launch and refresh can run between chunks.
  D.vetroIcon = function (appId, current) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(appId) || P.scopes.indexOf('apps.read') < 0)
      return Promise.reject(new Error('App icons are unavailable'));
    var total = null, revision = null, parts = [];
    function chunk(offset) {
      if (current && !current()) return Promise.reject(Object.assign(new Error('Icon read cancelled'), { code: 'cancelled' }));
      var params = { appId: appId, offset: offset };
      if (revision) params.revision = revision;
      return call('apps.icon', params).then(function (r) {
        if (current && !current()) throw Object.assign(new Error('Icon read cancelled'), { code: 'cancelled' });
        if (r && r.appId === appId && r.icon === null && offset === 0) return null;
        if (!r || r.appId !== appId || r.mimeType !== 'image/png' || r.offset !== offset ||
            !Number.isInteger(r.totalBytes) || r.totalBytes < 45 || r.totalBytes > 131072 ||
            typeof r.revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.revision) || typeof r.data !== 'string' ||
            r.data.length > 10924 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data))
          throw new Error('Invalid app icon');
        if (total === null) { total = r.totalBytes; revision = r.revision; }
        if (r.totalBytes !== total || r.revision !== revision) throw new Error('App icon changed');
        var bytes = window.atob(r.data), next = offset + bytes.length;
        if (bytes.length !== Math.min(8192, total - offset) || r.nextOffset !== (next < total ? next : null)) throw new Error('Invalid icon cursor');
        parts.push(bytes);
        if (r.nextOffset !== null) return chunk(r.nextOffset);
        var binary = parts.join(''), image = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) image[i] = binary.charCodeAt(i);
        function uint(at) { return image[at]*16777216 + image[at+1]*65536 + image[at+2]*256 + image[at+3]; }
        if (binary.slice(0,8) !== '\x89PNG\r\n\x1a\n' || uint(8) !== 13 || binary.slice(12,16) !== 'IHDR' ||
            !uint(16) || !uint(20) || uint(16) > 1024 || uint(20) > 1024 ||
            uint(binary.length-12) !== 0 || binary.slice(-8,-4) !== 'IEND' ||
            typeof window.sha256 !== 'function' || window.sha256(image) !== revision) throw new Error('Invalid app icon');
        return 'data:image/png;base64,' + window.btoa(binary);
      });
    }
    return chunk(0);
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
