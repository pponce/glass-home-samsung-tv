// Retrieve an app reply from Vetro on this TV. Requests and reply keys stay in
// the widget's MessagePort channel; this reader carries only a random reply ID.
'use strict';
var http = require('http');
var vetro = require('./vetro');
var ID = /^[0-9a-f]{64}$/;
var MAX_BYTES = 36 * 1024;
var TIMEOUT = 2500;
var FALLBACK_ERRORS = ['EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH'];

function unavailable() {
  var err = new Error('Vetro reply unavailable.');
  err.code = 'vetro-reply-unavailable';
  return err;
}

function requestReply(id, address, timeout) {
  return new Promise(function (resolve, reject) {
    var req, response, timer, done = false;
    function finish(err, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        try { if (response) response.destroy(); } catch (e) { /* already failed */ }
        try { if (req) req.destroy(); } catch (e) { /* already failed */ }
      } else resolve(result);
    }
    timer = setTimeout(function () { finish(unavailable()); }, timeout);
    try {
      req = http.request({
        hostname: address, localAddress: address, family: 4,
        port: 8099, path: '/app-replies/' + id, method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' }
      }, function (res) {
        response = res;
        res.on('error', function () { finish(unavailable()); });
        res.on('aborted', function () { finish(unavailable()); });
        if (done) { res.destroy(); return; }
        if ([200, 202, 404].indexOf(res.statusCode) < 0 ||
            Number(res.headers && res.headers['content-length']) > MAX_BYTES) {
          finish(unavailable()); return;
        }
        var chunks = [], size = 0;
        res.on('data', function (chunk) {
          if (done) return;
          try {
            var bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_BYTES) { finish(unavailable()); return; }
            if (res.statusCode === 200) chunks.push(bytes);
          } catch (e) { finish(unavailable()); }
        });
        res.on('end', function () {
          if (done) return;
          if (res.statusCode !== 200) {
            finish(null, { status: res.statusCode, body: null }); return;
          }
          try {
            var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body !== 'object' || Array.isArray(body) ||
                Object.keys(body).length !== 2 || typeof body.body !== 'string' ||
                typeof body.mac !== 'string' || !ID.test(body.mac)) throw unavailable();
            // The widget authenticates the exact body before interpreting it.
            finish(null, { status: 200, body: body });
          } catch (e) { finish(unavailable()); }
        });
      });
      req.on('error', function (cause) {
        var err = unavailable();
        // A response is conclusive. Never retry its HTTP, body or stream errors.
        if (!response && cause && FALLBACK_ERRORS.indexOf(cause.code) >= 0) err.retryLocal = true;
        finish(err);
      });
      req.end();
    } catch (e) { finish(unavailable()); }
  });
}

function readReply(id) {
  var deadline = Date.now() + TIMEOUT;
  return requestReply(id, '127.0.0.1', TIMEOUT).catch(function (err) {
    if (!err.retryLocal) throw err;
    // Only addresses currently assigned to this TV, never a supplied host.
    var addresses = vetro.localLanAddresses().slice(0, 3);
    function next(index) {
      var remaining = deadline - Date.now();
      if (index >= addresses.length || remaining <= 0) throw unavailable();
      return requestReply(id, addresses[index], remaining).catch(function (error) {
        if (!error.retryLocal) throw error;
        return next(index + 1);
      });
    }
    return next(0);
  });
}

function createReader() {
  var pending = Object.create(null), count = 0;
  return function (id) {
    if (typeof id !== 'string' || !ID.test(id)) return Promise.reject(unavailable());
    if (pending[id]) return pending[id];
    if (count >= 4) return Promise.reject(unavailable());
    count++;
    pending[id] = readReply(id).then(function (result) {
      delete pending[id]; count--; return result;
    }, function () {
      delete pending[id]; count--; throw unavailable();
    });
    return pending[id];
  };
}

module.exports = { createReader: createReader };
