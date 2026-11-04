#!/usr/bin/env node
// Real Glass service, widget adapter, SDK and HTTP polling; modeled Vetro
// MessagePort receiver. Vetro's own tests cover native identity/grant enforcement.
'use strict';
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const {createService} = require('../app/service/server.js');
const root = path.join(__dirname, '..');
const localKey = 'integration-only-package-key-0123456789';
const frames = new Map(), clients = [], nativeCalls = [], httpCalls = [];
let approved = false, metadata = true, mode = 'normal', launches = 0;
let previousFrame = null, service = null, tmp = null;

function sign(message, request) {
  const body = JSON.stringify(message);
  return {body, mac: crypto.createHmac('sha256', Buffer.from(request.reply.key, 'hex'))
    .update('VETRO_APP_REPLY_V2\n' + request.reply.id + '\n' + body).digest('hex')};
}

// Native request receipt is modeled independently of the HTTP response path.
// Reply attempts deliberately have no usable native sender metadata.
function nativeRequest(data, local) {
  assert.equal(data.length, 1);
  const request = JSON.parse(data[0].value);
  assert.equal(request.version, 2);
  assert.match(request.reply.id, /^[a-f0-9]{64}$/);
  assert.match(request.reply.key, /^[a-f0-9]{64}$/);
  assert.notEqual(request.reply.id, request.reply.key);
  nativeCalls.push(request.method);
  local.listener([{key: 'json', value: JSON.stringify({version: 1, id: request.id,
    ok: false, error: {code: 'permission_denied', submitted: false}})}], null);
  local.listener([{key: 'json', value: JSON.stringify({version: 1, id: request.id,
    ok: true, result: {state: 'approved', scopes: ['apps.read', 'apps.launch']}})}],
  {appId: 'impostor.svc', messagePortName: 'VETRO_APP_ACCESS_V1'});
  if (!metadata) return; // Unverified callers do not acquire an HTTP reply.
  let result, error;
  if (request.method === 'access.request') result = {state: approved ? 'approved' : 'pending', scopes: approved ? ['apps.read', 'apps.launch'] : []};
  else if (request.method === 'access.status') result = {state: approved ? 'approved' : 'revoked', scopes: approved ? ['apps.read', 'apps.launch'] : []};
  else if (!approved) error = {code: 'permission_denied', message: 'Permission required', submitted: false};
  else if (request.method === 'apps.list') result = {apps: [
    {appId: 'test.Netflix', name: 'Netflix', disabled: false},
    {appId: 'test.Disabled', name: 'Disabled', disabled: true}
  ], nextOffset: null};
  else if (request.method === 'apps.launch') {
    launches++;
    result = {ok: true, submitted: true, appId: request.params.appId};
  } else throw Error('Unexpected request method');
  const message = {version: 2, id: request.id, ok: !error};
  if (error) message.error = error; else message.result = result;
  let frame = sign(message, request);
  if (mode === 'tamper') frame = {body: frame.body + ' ', mac: frame.mac};
  if (mode === 'replay') frame = previousFrame;
  if (mode === 'normal') previousFrame = frame;
  frames.set(request.reply.id, {frame, pending: true});
}

const vetroServer = http.createServer((req, res) => {
  httpCalls.push({method: req.method, url: req.url});
  assert.equal(req.method, 'GET');
  assert.match(req.url, /^\/app-replies\/[a-f0-9]{64}$/);
  assert.equal(req.headers.authorization, undefined);
  const entry = frames.get(req.url.slice('/app-replies/'.length));
  res.setHeader('Content-Type', 'application/json');
  if (!entry) { res.writeHead(404); return res.end('{}'); }
  if (entry.pending) { entry.pending = false; res.writeHead(202); return res.end('{}'); }
  res.writeHead(200); res.end(JSON.stringify(entry.frame));
});

function httpJSON(port, route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const headers = {Connection: 'close'};
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({hostname: '127.0.0.1', port, path: route, method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString())}));
    });
    req.on('error', reject); req.end(body);
  });
}

// XMLHttpRequest backed by real HTTP, so data.js exercises the package-key
// channel and the production proxy instead of bypassing either one.
function XHR() { this.headers = {}; }
XHR.prototype.open = function (method, url) { this.method = method; this.url = url; };
XHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
XHR.prototype.send = function (body) {
  const self = this, target = new URL(this.url);
  let done = false;
  const req = http.request({hostname: target.hostname, port: target.port, path: target.pathname + target.search,
    method: this.method, headers: Object.assign({Connection: 'close'}, this.headers)}, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      if (done) return; done = true;
      self.status = res.statusCode; self.responseText = Buffer.concat(chunks).toString(); self.onload();
    });
    res.on('error', () => { if (!done) { done = true; self.onerror(); } });
  });
  req.setTimeout(this.timeout, () => { if (!done) { done = true; req.destroy(); self.ontimeout(); } });
  req.on('error', () => { if (!done) { done = true; self.onerror(); } });
  req.end(body);
};

function widget(port) {
  const GH = {config: {preview: false, serviceBase: 'http://127.0.0.1:' + port}};
  const window = {GH, GH_LOCAL_KEY: localKey, crypto: crypto.webcrypto, tizen: {messageport: {
    requestLocalMessagePort: () => ({addMessagePortListener(fn) { this.listener = fn; return 1; }, removeMessagePortListener() {}}),
    requestRemoteMessagePort: (appId, portName) => {
      assert.equal(appId, 'vetrotvapp.svc'); assert.equal(portName, 'VETRO_APP_ACCESS_V1');
      return {sendMessage: nativeRequest};
    }
  }}};
  const context = vm.createContext({window, XMLHttpRequest: XHR, Uint8Array, ArrayBuffer,
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    Promise, setTimeout, clearTimeout, Date, Math, console});
  // Browser UMD exports must land on the window global, as they do in the TV.
  context.window = context;
  Object.assign(context, window);
  for (const file of ['app/js/data.js', 'app/js/vendor/sha256.js', 'app/js/vetro-access-client.js'])
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  const SDK = context.VetroAppAccess;
  context.VetroAppAccess = function (options) {
    assert.equal(options.httpReplies, true);
    assert.equal(options.pollReply, GH.data.vetroReply);
    // Bound the deliberately unanswered request test without altering production.
    const client = new SDK(Object.assign({}, options, {timeout: 1200}));
    clients.push(client); return client;
  };
  let legacy = 0;
  GH.data.vetroApps = () => { legacy++; throw Error('Unexpected legacy app list'); };
  GH.data.vetroLaunch = () => { legacy++; throw Error('Unexpected legacy launch'); };
  vm.runInContext(fs.readFileSync(path.join(root, 'app/js/vetro-permissions.js'), 'utf8'), context);
  return {GH, legacy: () => legacy};
}

(async () => {
  tmp = fs.mkdtempSync(path.join(__dirname, 'reply-integration-'));
  fs.mkdirSync(path.join(tmp, 'js'));
  fs.writeFileSync(path.join(tmp, 'js', 'local-key.js'), 'window.GH_LOCAL_KEY=' + JSON.stringify(localKey) + ';');
  // Reserve a free service port without assuming the developer has 8090 free.
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  service = createService({appDir: tmp, dataDir: path.join(tmp, 'data'), port, hosts: ['127.0.0.1'],
    config: {fetchIcons: false}, log() {}});
  await new Promise((resolve, reject) => service.start(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => { vetroServer.once('error', reject); vetroServer.listen(8099, '127.0.0.1', resolve); });

  const route = '/local/vetro/replies/' + 'a'.repeat(64), keyed = route + '?k=' + localKey;
  assert.equal((await httpJSON(port, route)).status, 403, 'reply route requires package-local key');
  assert.equal((await httpJSON(port, keyed, 'POST', '{}')).status, 405);
  assert.equal((await httpJSON(port, keyed + '&method=apps.launch')).status, 400);
  assert.equal((await httpJSON(port, keyed, 'GET', 'x')).status, 400);
  assert.equal((await httpJSON(port, '/local/vetro/replies/invalid?k=' + localKey)).status, 400);
  assert.equal(httpCalls.length, 0, 'rejected local requests do not contact Vetro');
  assert.equal((await httpJSON(port, '/health')).body.vetroPermissions, 2);

  const w = widget(port);
  assert.match(await w.GH.vetroPermissions.connect(), /approve Glass Home/);
  approved = true;
  const list = await w.GH.data.vetroApps(true);
  assert.equal(list.transport, 'permissions');
  assert.deepEqual(JSON.parse(JSON.stringify(list.apps)), [{appId: 'test.Netflix', label: 'Netflix'}]);
  assert.equal(await w.GH.data.vetroLaunch('test.Netflix'), true);
  assert.equal(launches, 1);
  assert.equal(w.legacy(), 0);
  assert.ok(httpCalls.length >= nativeCalls.length * 2, 'pending replies are polled without native redispatch');

  approved = false;
  assert.equal((await w.GH.data.vetroApps()).available, false);
  assert.equal(await w.GH.data.vetroLaunch('test.Netflix'), false, 'authenticated pre-dispatch refusal permits caller fallback');
  assert.equal(launches, 1);
  approved = true; mode = 'tamper';
  assert.equal((await w.GH.data.vetroApps()).error.code, 'invalid_reply');
  const before = nativeCalls.length;
  await assert.rejects(w.GH.data.vetroLaunch('test.Netflix'), error => error.launchUnconfirmed === true && error.submitted === null);
  assert.equal(nativeCalls.length, before + 1, 'lost authentication does not redispatch a launch');
  assert.equal(launches, 2);
  mode = 'replay';
  assert.equal((await w.GH.data.vetroApps()).error.code, 'invalid_reply', 'valid MAC for a different request is rejected');
  mode = 'normal'; metadata = false;
  const missingBefore = nativeCalls.length;
  assert.equal((await w.GH.data.vetroApps()).error.code, 'timeout', 'unsigned/native replies cannot complete V2 authentication');
  assert.equal(nativeCalls.length, missingBefore + 1);
  assert.equal(w.legacy(), 0, 'failed authentication never downgrades to legacy HTTP');
  assert.ok(httpCalls.every(call => /^\/app-replies\/[a-f0-9]{64}$/.test(call.url)), 'HTTP carries only reply IDs');
  console.log('PASS permissions reply integration: real Glass service/SDK, pending polling, approval/list/launch, route authentication, revocation, MAC tamper/replay, dropped native replies, no duplicate launch or downgrade');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clients.forEach(client => client.close());
  if (service) await new Promise(resolve => service.stop(resolve));
  if (vetroServer.listening) await new Promise(resolve => vetroServer.close(resolve));
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});
