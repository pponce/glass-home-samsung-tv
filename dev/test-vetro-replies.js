#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const EventEmitter = require('events');
const source = fs.readFileSync(path.join(__dirname, '../app/service/vetro-replies.js'), 'utf8');
const id = n => n.toString(16).padStart(64, '0');
const envelope = { body: '{"version":2,"id":"request","ok":true}', mac: 'a'.repeat(64) };
let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message); checks++;
}
async function rejected(promise, message) {
  await assert.rejects(promise, err => {
    equal(Object.keys(err), ['code'], 'errors expose no IDs, addresses or transport details');
    return err.code === 'vetro-reply-unavailable' && err.message === 'Vetro reply unavailable.';
  }, message); checks++;
}
function load(network, addresses, clock, timers) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer, Promise,
    Date: clock || Date,
    setTimeout: timers ? timers.set : setTimeout,
    clearTimeout: timers ? timers.clear : clearTimeout,
    require: name => name === 'http' ? network : { localLanAddresses: () => addresses || [] }
  });
  return module.exports.createReader();
}
function simulation(outcomes, addresses) {
  let now = 0, destroyed = 0;
  const calls = [], delays = [], timers = new Map();
  const network = { request: (opts, onResponse) => {
    calls.push(opts);
    const req = new EventEmitter();
    req.destroy = () => { destroyed++; };
    req.end = () => {
      const result = outcomes[calls.length - 1] || { error: 'ECONNREFUSED' };
      now += result.elapsed || 0;
      if (result.error) return req.emit('error', { code: result.error });
      if (result.hang) return;
      const res = new EventEmitter();
      res.destroy = () => { destroyed++; };
      res.statusCode = result.status || 200;
      res.headers = result.headers || {};
      onResponse(res);
      if (result.aborted) return res.emit('aborted');
      res.emit('data', result.body === undefined ? JSON.stringify(envelope) : result.body);
      res.emit('end');
    };
    return req;
  } };
  return {
    reader: load(network, addresses, { now: () => now }, {
      set: (fn, delay) => { timers.set(fn, delay); delays.push(delay); return fn; },
      clear: fn => timers.delete(fn)
    }), calls, delays, timers, destroyed: () => destroyed
  };
}

(async () => {
  let s = simulation([{ error: 'EACCES', elapsed: 200 }, { status: 200 }], ['192.168.84.19']);
  equal(await s.reader(id(1)), { status: 200, body: envelope }, 'own-address fallback delivers opaque envelope');
  equal(s.calls.map(c => [c.hostname, c.localAddress, c.port, c.method, c.path]), [
    ['127.0.0.1', '127.0.0.1', 8099, 'GET', '/app-replies/' + id(1)],
    ['192.168.84.19', '192.168.84.19', 8099, 'GET', '/app-replies/' + id(1)]
  ], 'fixed destination port/path and source binding; no key or operation');
  equal(s.delays, [2500, 2300], 'all attempts share one deadline');
  equal(s.timers.size, 0, 'completed reads clear timers');

  for (const error of ['EPERM', 'ENETUNREACH', 'EHOSTUNREACH']) {
    s = simulation([{ error }, {}], ['10.0.0.5']);
    await s.reader(id(1)); equal(s.calls.length, 2, error + ' permits own-address fallback');
  }
  for (const error of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
    s = simulation([{ error }, {}], ['10.0.0.5']);
    await rejected(s.reader(id(1)), error + ' is not rerouted');
    equal(s.calls.length, 1, 'no extra network attempt');
  }
  s = simulation(Array(5).fill({ error: 'EACCES' }), ['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']);
  await rejected(s.reader(id(1))); equal(s.calls.length, 4, 'at most three current own addresses');
  s = simulation([{ error: 'EACCES', elapsed: 2501 }, {}], ['10.0.0.5']);
  await rejected(s.reader(id(1))); equal(s.calls.length, 1, 'expired deadline prevents another attempt');
  s = simulation([{ error: 'EACCES' }, { status: 403 }, {}], ['10.0.0.2', '10.0.0.3']);
  await rejected(s.reader(id(1))); equal(s.calls.length, 2, 'HTTP failure never falls through to another address');
  s = simulation([{ hang: true }], ['10.0.0.5']);
  const timed = s.reader(id(1));
  Array.from(s.timers.keys()).forEach(fn => fn());
  await rejected(timed); equal(s.destroyed(), 1, 'timeout destroys request');
  equal(s.calls.length, 1, 'timeout never redispatches');
  s = simulation([{ status: 200, aborted: true }], ['10.0.0.5']);
  await rejected(s.reader(id(1))); equal(s.calls.length, 1, 'interrupted body never retries');

  let respond, seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, method: req.method, peer: req.socket.remoteAddress });
    respond(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  // Only this test adapter rewrites the port, allowing real HTTP on an ephemeral
  // listener while checking that production always requests the fixed port.
  const network = { request: (opts, callback) => {
    assert.strictEqual(opts.port, 8099);
    assert.strictEqual(opts.hostname, '127.0.0.1');
    return http.request(Object.assign({}, opts, { port: server.address().port }), callback);
  } };
  const reader = load(network);
  try {
    for (const invalid of ['', '../exec', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '?key=secret', {}, null]) {
      await rejected(reader(invalid), 'invalid IDs cannot make network requests');
    }
    equal(seen.length, 0, 'invalid IDs stay local');
    respond = (req, res) => setTimeout(() => res.end(JSON.stringify(envelope)), 15);
    const first = reader(id(1)), same = reader(id(1));
    assert.strictEqual(first, same); checks++;
    equal(await first, { status: 200, body: envelope }, 'actual HTTP response preserved');
    equal(seen.length, 1, 'concurrent reads of one ID coalesce');
    equal(seen[0], { path: '/app-replies/' + id(1), method: 'GET', peer: '127.0.0.1' }, 'actual request has no operation or key');
    await reader(id(1)); equal(seen.length, 2, 'completed replies are not cached');

    for (const status of [202, 404]) {
      respond = (req, res) => { res.statusCode = status; res.end('not parsed'); };
      equal(await reader(id(2)), { status, body: null }, 'pending or missing response body is ignored');
    }
    for (const status of [301, 400, 401, 403, 500]) {
      respond = (req, res) => { res.statusCode = status; res.setHeader('Location', 'http://example.invalid/exec'); res.end(); };
      const before = seen.length;
      await rejected(reader(id(3))); equal(seen.length, before + 1, 'no redirect or status retry');
    }
    for (const body of ['{', 'null', '[]', '{"body":"x","mac":"bad"}', JSON.stringify({ body: '', mac: 'a'.repeat(64), extra: true })]) {
      respond = (req, res) => res.end(body);
      await rejected(reader(id(4)), 'malformed frames rejected');
    }
    respond = (req, res) => { res.writeHead(200); res.write('x'.repeat(36 * 1024)); res.end('x'); };
    await rejected(reader(id(5)), 'streamed body size bounded');
    respond = (req, res) => { res.setHeader('Content-Length', 36 * 1024 + 1); res.flushHeaders(); };
    await rejected(reader(id(5)), 'advertised oversize body rejected immediately');
    respond = (req, res) => { res.writeHead(202); res.end('x'.repeat(36 * 1024 + 1)); };
    await rejected(reader(id(5)), 'pending response body is bounded too');
    respond = (req, res) => { res.writeHead(200); res.write('{'); setTimeout(() => res.destroy(), 5); };
    await rejected(reader(id(5)), 'aborted response releases reader slot');

    const held = [];
    respond = (req, res) => held.push(res);
    const pending = [10, 11, 12, 13].map(n => reader(id(n)));
    await rejected(reader(id(14)), 'at most four distinct reads are active');
    while (held.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
    held.forEach(res => res.end(JSON.stringify(envelope)));
    await Promise.all(pending);
    respond = (req, res) => res.end(JSON.stringify(envelope));
    await reader(id(14)); checks++;
    respond = () => {};
    const start = Date.now();
    await rejected(reader(id(20)), 'actual hanging HTTP request times out');
    assert(Date.now() - start >= 2400 && Date.now() - start < 4000); checks++;
    respond = (req, res) => res.end(JSON.stringify(envelope));
    await reader(id(20)); checks++;
  } finally {
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Vetro reply proxy: ' + checks + ' checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
