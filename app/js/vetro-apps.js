/* Optional Vetro catalog and saved dock selection. */
(function () {
  'use strict';
  var GH = window.GH, cfg = GH.config, ls = GH.ls;
  var saved = ls.get('gh.vetro.v1') || {}, savedHidden = ls.get('gh.hidden');
  function catalogSource(value) { return value === 'samsung-apps' || value === 'samsung-home'; }
  function valid(list) {
    var seen = Object.create(null);
    if (!Array.isArray(list) || list.length > 2000) throw new Error('Invalid app catalog');
    return list.map(function (e) {
      if (!e || typeof e.appId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(e.appId) || typeof e.label !== 'string' || !e.label.trim() || seen[e.appId] ||
          !(e.homeOrder === null || Number.isInteger(e.homeOrder) && e.homeOrder >= 0 && e.homeOrder < 300)) throw new Error('Invalid app entry');
      seen[e.appId] = true;
      return { appId: e.appId, label: e.label.slice(0,120), homeOrder: e.homeOrder };
    });
  }
  var cached = [];
  try { if (catalogSource(saved.source)) cached = valid(saved.entries); } catch (e) { saved.source = null; }
  var V = {
    entries: cached,
    source: catalogSource(saved.source) ? saved.source : null,
    selected: Array.isArray(saved.selected) ? saved.selected.filter(function (s) { return typeof s === 'string'; }) : null,
    hidden: Array.isArray(savedHidden) ? savedHidden.slice() : [],
    preferencesReady: false,
    preferencesError: false,
    saving: false,
    available: false,
    loading: false,
    iconSupport: false,
    error: null
  };
  var pending = null;
  var restoring = null;
  var iconCache = Object.create(null), iconAttempts = Object.create(null), iconGeneration = 0, iconWork = null;
  var ICON_CACHE = 'gh.vetro.icons.v1', ICON_BUDGET = 2 * 1024 * 1024;
  function iconUrl(value) {
    return typeof value === 'string' && value.length <= 174786 &&
      /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);
  }
  var savedIcons = ls.get(ICON_CACHE), iconBytes = 0;
  if (Array.isArray(savedIcons) && savedIcons.length <= 64) savedIcons.forEach(function (entry) {
    if (entry && typeof entry.appId === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(entry.appId) && iconUrl(entry.url) &&
        typeof entry.at === 'number' && entry.at <= Date.now() && Date.now()-entry.at < 86400000 && iconBytes+entry.url.length <= ICON_BUDGET) {
      iconCache[entry.appId] = { url: entry.url, at: entry.at }; iconBytes += entry.url.length;
    }
  });
  function saveIcons() {
    var size = 0, list = Object.keys(iconCache).map(function (id) { return { appId:id, url:iconCache[id].url, at:iconCache[id].at }; })
      .sort(function (a,b) { return b.at-a.at; });
    list = list.filter(function (entry,index) { size += entry.url.length; return index < 64 && size <= ICON_BUDGET; });
    ls.set(ICON_CACHE, list);
  }
  V.iconFor = function (def, nativeIcon) {
    if (typeof def.icon === 'string' && def.icon) return def.icon;
    var cachedIcon = def.fromVetro && iconCache[def.ids[0]];
    return cachedIcon ? cachedIcon.url : def.icon === false ? null : nativeIcon;
  };
  V.loadIcons = function (changed, visible) {
    if (iconWork) return iconWork;
    function current() { return V.available && V.iconSupport && !V.loading && (!visible || visible()); }
    function next() {
      if (!current() || typeof GH.data.vetroIcon !== 'function') return;
      var selected = V.definitions(), active = selected.map(function (d) { return d.ids[0]; });
      Object.keys(iconCache).forEach(function (id) { if (active.indexOf(id) < 0) delete iconCache[id]; });
      var used = Object.keys(iconCache).reduce(function (sum,id) { return sum+iconCache[id].url.length; },0);
      if (used > 8*1024*1024-174786) return;
      var defs = selected.filter(function (d) { return !(typeof d.icon === 'string' && d.icon) && V.hidden.indexOf(d.key) < 0 && iconAttempts[d.ids[0]] !== iconGeneration; });
      // Fill name-only tiles first; the remaining apps retain their native images meanwhile.
      defs.sort(function (a,b) { return Number(b.icon === false)-Number(a.icon === false); });
      if (!defs.length) return;
      var id = defs[0].ids[0], generation = iconGeneration;
      iconAttempts[id] = generation;
      return GH.data.vetroIcon(id, current).then(function (url) {
        if (url !== null && !iconUrl(url)) throw new Error('Invalid app icon');
        if (url) iconCache[id] = { url:url, at:Date.now() }; else delete iconCache[id];
        saveIcons();
        if (changed) changed();
      }).catch(function (error) {
        if (error && error.code === 'cancelled') { delete iconAttempts[id]; return; }
        // A failed permission or authenticated reply stops this background pass.
        V.iconSupport = false;
      }).then(next);
    }
    iconWork = Promise.resolve().then(next).then(function () { iconWork = null; }, function () { iconWork = null; });
    return iconWork;
  };
  function persist() { ls.set('gh.vetro.v1', { entries: V.entries, selected: V.selected, source: V.source }); }
  function applyPreferences(prefs) {
    if (!prefs || !(prefs.selected === null || Array.isArray(prefs.selected)) || !Array.isArray(prefs.hidden)) throw new Error('invalid preferences');
    V.selected = prefs.selected === null ? null : prefs.selected.slice();
    V.hidden = prefs.hidden.slice();
    persist();
    ls.set('gh.hidden', V.hidden);
  }
  V.loadPreferences = function () {
    if (V.preferencesReady) return Promise.resolve();
    if (restoring) return restoring;
    restoring = GH.data.dockPreferences().then(function (prefs) {
      return prefs === null ? GH.data.saveDockPreferences({ selected: V.selected, hidden: V.hidden }, true) : prefs;
    }).then(function (prefs) {
      applyPreferences(prefs);
      V.preferencesReady = true;
      V.preferencesError = false;
      restoring = null;
    }).catch(function (err) { V.preferencesError = true; restoring = null; throw err; });
    return restoring;
  };
  V.save = function (ids, hidden) {
    if (!V.preferencesReady || V.saving) return Promise.reject(new Error('preferences not ready'));
    V.saving = true;
    return GH.data.saveDockPreferences({ selected: ids === null ? null : ids.slice(), hidden: (hidden || V.hidden).slice() }).then(function (prefs) {
      applyPreferences(prefs);
      V.saving = false;
    }).catch(function (err) { V.saving = false; throw err; });
  };
  V.refresh = function (refresh) {
    if (pending) return pending;
    if (refresh) iconGeneration++;
    V.loading = true;
    pending = V.loadPreferences().catch(function () { /* use cached choices until retry */ }).then(function () {
      return GH.data.vetroApps(refresh);
    }).then(function (result) {
      V.available = !!(result && result.available);
      V.iconSupport = V.available && result.iconSupport === true;
      V.error = V.available ? null : result && result.error || null;
      if (V.available) {
        if (!catalogSource(result.source)) throw new Error('Invalid catalog source');
        V.entries = valid(result.apps);
        V.source = result.source;
        // null follows Samsung Home; explicit selections persist across refreshes.
        persist();
      }
    }).catch(function (err) {
      V.available = false;
      V.error = err && err.vetro || { code: 'service', message: 'Glass Home could not retrieve its app list.' };
    }).then(function () {
      V.loading = false; pending = null;
      return V;
    });
    return pending;
  };
  V.failureText = function () {
    var e = V.error || {};
    if (['disabled','permission_denied','identity_changed','update_required'].indexOf(e.code) >= 0) return e.message;
    if (e.code === 'empty') return 'Vetro has no launchable apps';
    if (e.code === 'timeout') return 'Vetro did not respond';
    if (e.code === 'http') return 'Vetro returned HTTP ' + e.status;
    if (e.code === 'connection' || e.code === 'request') return 'Could not connect to Vetro';
    if (e.code === 'service') return 'Glass Home could not retrieve its app list';
    if (e.code) return 'Could not read the Vetro app list';
    return 'Vetro app list unavailable';
  };
  V.diagnostic = function () {
    var e = V.error;
    if (!e) return '';
    return ['Vetro', e.code, e.detail, e.message].filter(function (s) { return !!s; }).join(' · ').slice(0, 360);
  };
  V.active = function () { return catalogSource(V.source); };
  V.defaultIds = function () {
    return V.entries.filter(function (e) { return e.homeOrder !== null; }).map(function (e) { return e.appId; });
  };
  V.selection = function () { return V.selected === null ? V.defaultIds() : V.selected.slice(); };
  V.saveSelection = function (ids) {
    var selected = ids === null ? V.defaultIds() : ids;
    var removed = V.selection().filter(function (id) { return selected.indexOf(id) < 0; });
    // Hiding is independent of selection. Only a deselected app loses its
    // hidden flag; preserve inputs, unavailable selected apps and unknown keys.
    var hidden = V.hidden.filter(function (key) {
      if (key.indexOf('in:') === 0) return true;
      var id = key.indexOf('vetro:') === 0 ? key.slice(6) : null;
      var known = cfg.apps.filter(function (d) { return d.key === key || id && d.ids.indexOf(id) >= 0; })[0];
      var appIds = known ? known.ids : id ? [id] : [];
      return !appIds.some(function (appId) { return removed.indexOf(appId) >= 0; }) ||
        appIds.some(function (appId) { return selected.indexOf(appId) >= 0; });
    });
    return V.save(ids, hidden);
  };
  V.definitions = function (selection) {
    var selected = arguments.length ? selection : V.selected;
    if (!V.active()) {
      if (!V.preferencesReady || selected === null) return cfg.apps;
      return cfg.apps.filter(function (d) {
        return d.ids.some(function (id) { return selected.indexOf(id) >= 0; });
      });
    }
    if (selected === null) selected = V.defaultIds();
    return V.entries.filter(function (e) { return selected.indexOf(e.appId) >= 0; }).map(function (e) {
      var known = cfg.apps.filter(function (d) { return d.ids.indexOf(e.appId) >= 0; })[0];
      var def = { key: known ? known.key : 'vetro:' + e.appId, label: e.label, ids: [e.appId], names: [], fromVetro: true };
      if (known) {
        def.ids = [e.appId].concat(known.ids.filter(function (id) { return id !== e.appId; }));
        def.storeId = known.storeId;
        if (known.icon !== undefined) def.icon = known.icon;
      }
      return def;
    });
  };
  GH.vetro = V;
}());
