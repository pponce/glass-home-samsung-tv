#!/usr/bin/env node
// Exercise the real remote handlers, dock rendering, persistence and refreshes.
'use strict';
const assert = require('assert');
const { boot, deferred, settle } = require('./test-startup');
const K = { LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40, OK: 13, BACK: 10009 };
const entries = [
  ['org.tizen.netflix-app', 'Netflix'], ['com.samsung.tv.tvPlusDeeplinker', 'Samsung TV Plus'],
  ['com.samsung.tv.cobalt-yt', 'YouTube'], ['3201807016597', 'Apple TV']
].map(([appId, label], homeOrder) => ({ appId, label, homeOrder }));
let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify([actual])), JSON.parse(JSON.stringify([expected])), message); checks++;
}
const active = t => t.get('move-hint').classList.contains('open');
const focused = t => t.get('dock-row').children.findIndex(el => el.classList.contains('focused'));
const label = t => t.get('label').textContent;
function hold(t) { t.down(K.OK); t.expire(t.GH.config.longPressMs); t.up(K.OK); }
function startMove(t) { hold(t); t.key(K.OK); }
async function ready(options = {}) {
  const t = boot(Object.assign({ entries }, options));
  await settle();
  t.preferences.resolve({ selected: null, hidden: [] }); await settle();
  return t;
}

(async () => {
  const t = await ready();
  const original = t.labels();
  hold(t);
  equal(t.get('menu').children.slice(1).map(el => el.textContent), ['Move', 'Hide', 'Cancel'], 'one Move action');
  t.down(K.OK); t.down(K.OK); t.down(K.OK, true);
  equal(active(t), true, 'held OK selecting Move cannot also place it');
  t.up(K.OK);
  equal([t.get('move-position').textContent, t.get('move-left').classList.contains('disabled')], ['1 of 4', true], 'position and left boundary shown');
  t.key(K.LEFT);
  equal(t.labels(), original, 'left edge never wraps');
  t.key(K.RIGHT); t.down(K.RIGHT, true); t.down(K.RIGHT, true); t.up(K.RIGHT);
  equal(t.labels(), ['Samsung TV Plus', 'YouTube', 'Apple TV', 'Netflix'], 'repeated Right keeps moving the same app');
  equal([focused(t), label(t), active(t)], [3, 'Netflix', true], 'focus follows the tile without closing Move');
  equal(t.stored['gh.appOrder'], undefined, 'draft is not persisted');
  t.key(K.RIGHT); t.key(K.UP); t.key(K.DOWN);
  equal([focused(t), t.get('move-right').classList.contains('disabled')], [3, true], 'right edge cannot cross into inputs and vertical keys keep mode');
  t.poll(); await settle();
  equal(t.labels(), ['Samsung TV Plus', 'YouTube', 'Apple TV', 'Netflix'], 'background refresh preserves the draft');
  t.key(K.BACK);
  equal([t.labels(), active(t), label(t)], [original, false, 'Netflix'], 'Back cancels and keeps the same app focused');
  equal(t.stored['gh.appOrder'], undefined, 'cancel does not save order');

  startMove(t); t.key(K.RIGHT); t.key(K.RIGHT);
  t.down(K.OK); t.down(K.OK); t.down(K.OK, true); t.up(K.OK);
  equal([active(t), t.launches()], [false, 0], 'placing with held OK saves once without launching');
  const saved = t.labels();
  const reopened = await ready({ stored: { 'gh.appOrder': t.stored['gh.appOrder'] } });
  equal(reopened.labels(), saved, 'placed order survives reopening');
  t.key(K.OK); await settle();
  equal(t.launches(), 1, 'a fresh OK after placing opens the app');

  const fail = await ready();
  const setter = fail.GH.ls.set;
  fail.GH.ls.set = (key, value) => { if (key !== 'gh.appOrder') setter(key, value); };
  startMove(fail); fail.key(K.RIGHT); fail.key(K.OK);
  equal([active(fail), fail.get('toast').textContent.includes('retry')], [true, true], 'failed storage write keeps the draft for retry');
  fail.GH.ls.set = setter; fail.key(K.OK);
  equal(active(fail), false, 'retry can save the position');

  const icon = await ready(); startMove(icon); icon.key(K.RIGHT);
  const previousTile = icon.get('dock-row').children[1];
  icon.GH.vetro.iconFor = () => 'data:image/png;base64,fixture';
  icon.poll(); await settle();
  equal(icon.get('dock-row').children[1] === previousTile, false, 'icon arrival replaces the rendered tile');
  equal([focused(icon), label(icon), icon.get('dock-row').children[1].classList.contains('moving')], [1, 'Netflix', true], 'replacement artwork retains the move and focus');
  icon.document.hidden = true; icon.foreground();
  equal([active(icon), icon.stored['gh.appOrder']], [false, undefined], 'leaving the launcher cancels an unplaced move');

  const gone = await ready(); startMove(gone); gone.key(K.RIGHT);
  gone.GH.vetro.hidden.push('netflix'); gone.poll(); await settle();
  equal([active(gone), gone.get('toast').textContent], [false, 'This item is no longer on the dock.'], 'removal during Move safely releases the mode');
  const single = await ready({ entries: entries.slice(0, 1) }); hold(single);
  equal(single.get('menu').children[1].classList.contains('disabled'), true, 'one app has no valid move');

  const inputs = await ready({ focus: 4, inputs: [{ hdmi: 2, label: 'Console' }, { hdmi: 3, label: 'Player' }, { tv: true, label: 'TV' }] });
  startMove(inputs); inputs.key(K.RIGHT); inputs.key(K.RIGHT); inputs.key(K.OK);
  equal(inputs.stored['gh.inputOrder'], ['in:3', 'in:tv', 'in:2'], 'inputs use the same continuous move controls');

  const shortcuts = ['a', 'b', 'c'].map(id => ({ id, type: id === 'c' ? 'youtube' : 'web', name: id.toUpperCase(), url: 'https://example.com/' + id, videoId: 'abcdefghijk' }));
  const sc = await ready({ shortcuts, focus: 5 });
  let calls = 0, ids;
  let save = deferred();
  sc.GH.data.orderShortcuts = order => { calls++; ids = order; return save.promise; };
  startMove(sc); sc.key(K.RIGHT); sc.key(K.RIGHT);
  equal(calls, 0, 'shortcut arrows do not call the service');
  sc.key(K.OK); sc.key(K.OK); sc.key(K.LEFT); sc.key(K.BACK);
  equal([calls, ids, focused(sc), sc.get('move-help').textContent], [1, ['b', 'c', 'a'], 7, 'Saving position…'], 'one save request freezes controls until confirmed');
  save.reject(new Error('offline')); await settle();
  equal([active(sc), focused(sc)], [true, 7], 'service failure retains draft for retry');
  save = deferred(); sc.key(K.OK);
  const pendingPoll = deferred();
  sc.GH.data.refresh = () => pendingPoll.promise;
  sc.poll();
  save.resolve(); await settle();
  pendingPoll.resolve({ changed: true, online: true, state: { shortcuts } }); await settle();
  equal([active(sc), label(sc), focused(sc)], [false, 'A', 7], 'late pre-save poll cannot roll back the committed shortcut order');
  sc.key(K.LEFT);
  equal(label(sc), 'C', 'website and video shortcuts share their section');
  startMove(sc); sc.key(K.LEFT); sc.key(K.BACK);
  equal([calls, focused(sc)], [2, 6], 'shortcut cancel restores placed order without a request');

  console.log(checks + ' dock move checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
