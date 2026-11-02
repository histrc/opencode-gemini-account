import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPv4Targets, createStudioIPv4Proxy, checkTargetTLS, allowedGoogleTarget } from '../src/studio-ipv4-proxy.mjs';
import { managedStudioProxy, validateIPv4Upstream } from '../src/studio-network.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const answer = (ip, TTL = 5) => ({ Answer: [{ type: 1, data: ip, TTL }] });
const root = path.dirname(fileURLToPath(import.meta.url));

test('IPv4 compatibility accepts only Google targets and an explicit HTTP upstream', () => {
  assert.equal(allowedGoogleTarget('aistudio.google.com', 443), true);
  for (const host of ['google.com.evil.invalid', 'evilgoogle.com', '127.0.0.1', 'example.com']) assert.equal(allowedGoogleTarget(host, 443), false);
  assert.equal(allowedGoogleTarget('aistudio.google.com', 22), false);
  assert.deepEqual(validateIPv4Upstream('http://127.0.0.1:7897'), { proxyHost: '127.0.0.1', proxyPort: 7897 });
  for (const value of ['socks5://127.0.0.1:7897', 'http://user:pass@127.0.0.1:7897', 'http://127.0.0.1:7897/path']) assert.throws(() => validateIPv4Upstream(value));
});

test('network helper is opt-in, shared across callers, and recovers its port after a crash', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-managed-network-'));
  const dataDir = path.join(directory, 'backend');
  const upstream = 'http://127.0.0.1:7897';
  let ownedPid;
  try {
    assert.equal(await managedStudioProxy(directory, dataDir, upstream), upstream);
    await mkdir(dataDir);
    await writeFile(path.join(directory, 'managed-network.json'), JSON.stringify({ proxy: upstream, studioIPv4: true }));
    const urls = await Promise.all(Array.from({ length: 5 }, () => managedStudioProxy(directory, dataDir, upstream)));
    assert.ok(urls.every(url => url === urls[0]));
    const file = path.join(dataDir, 'network-helper.json');
    const first = JSON.parse(await readFile(file, 'utf8'));
    ownedPid = first.pid;
    const health = await (await fetch(urls[0] + '/_aistudio_proxy/health')).json();
    assert.equal(health.instance, first.instance);
    process.kill(ownedPid);
    // SIGTERM closes the helper gracefully. Wait for the listener to close.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(ownedPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { break; }
    }
    const recovered = await managedStudioProxy(directory, dataDir, upstream);
    const second = JSON.parse(await readFile(file, 'utf8'));
    ownedPid = second.pid;
    assert.equal(recovered, urls[0]);
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.instance, second.instance);
  } finally {
    if (ownedPid) try { process.kill(ownedPid); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function upstream(handler) {
  const sockets = new Set();
  const requests = [];
  const server = http.createServer();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (request, socket, head) => { requests.push(request.url); handler(request, socket, head); });
  return { port: await listen(server), requests,
    close: () => new Promise(resolve => { server.close(resolve); sockets.forEach(socket => socket.destroy()); }),
  };
}
async function rawRequest(port, data = 'hello', pauseMs = 0) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let header = Buffer.alloc(0);
    let status;
    let result = '';
    const timer = setTimeout(() => socket.destroy(new Error('Test client timed out')), 3000);
    socket.on('connect', () => socket.write('CONNECT service.google.com:443 HTTP/1.1\r\nHost: service.google.com:443\r\n\r\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      if (status === undefined) {
        header = Buffer.concat([header, chunk]);
        const boundary = header.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        status = Number(header.toString('ascii').match(/^HTTP\/1\.1 (\d+)/)?.[1]);
        result += header.subarray(boundary + 4).toString();
        if (status === 200) {
          socket.write(data);
          if (pauseMs) { socket.pause(); setTimeout(() => socket.resume(), pauseMs); }
        }
      } else result += chunk.toString();
    });
    socket.once('close', () => { clearTimeout(timer); resolve({ status, result }); });
  });
}

test('expired DNS addresses are refreshed and the new IP is rechecked', async () => {
  let now = 0;
  let calls = 0;
  const checked = [];
  const targets = new IPv4Targets({ now: () => now,
    lookupFn: async () => answer(++calls === 1 ? '93.184.216.34' : '142.251.24.95'),
    checkFn: async (_host, ip) => checked.push(ip),
  });
  assert.equal(await targets.target('service.example', 443), '93.184.216.34');
  now = 4999;
  assert.equal(await targets.target('service.example', 443), '93.184.216.34');
  now = 5001;
  assert.equal(await targets.target('service.example', 443), '142.251.24.95');
  assert.equal(calls, 2);
  assert.deepEqual(checked, ['93.184.216.34', '142.251.24.95']);
});

test('simultaneous connections share DNS and TLS validation', async () => {
  let lookups = 0;
  let checks = 0;
  const targets = new IPv4Targets({ lookupFn: async () => { lookups++; return answer('93.184.216.34'); },
    checkFn: async () => { checks++; },
  });
  const ips = await Promise.all(Array.from({ length: 20 }, () => targets.target('service.example', 443)));
  assert.ok(ips.every(ip => ip === '93.184.216.34'));
  assert.equal(lookups, 1);
  assert.equal(checks, 1);
});

test('a failed address is skipped before opening the application tunnel', async () => {
  const checked = [];
  const targets = new IPv4Targets({
    lookupFn: async () => ({ Answer: [...answer('93.184.216.34').Answer, ...answer('142.251.24.95').Answer] }),
    checkFn: async (_host, ip) => { checked.push(ip); if (ip === '93.184.216.34') throw new Error('Simulated TLS EOF'); },
  });
  assert.equal(await targets.target('service.example', 443), '142.251.24.95');
  assert.deepEqual(checked, ['93.184.216.34', '142.251.24.95']);
});

test('expired DNS is not silently used after every resolver fails', async () => {
  let now = 0;
  const targets = new IPv4Targets({ now: () => now,
    lookupFn: async () => { if (now) throw new Error('DNS offline'); return answer('93.184.216.34'); },
    checkFn: async () => {},
  });
  await targets.target('service.example', 443);
  now = 5001;
  await assert.rejects(targets.target('service.example', 443), /DNS offline/);
});

test('unreachable DNS results fall back to an independent resolver', async () => {
  const targets = new IPv4Targets({
    lookupFn: async () => answer('93.184.216.34'),
    alternateLookupFn: async () => answer('142.251.24.95'),
    checkFn: async (_host, ip) => { if (ip === '93.184.216.34') throw new Error('Unreachable DNS answer'); },
  });
  assert.equal(await targets.target('service.example', 443), '142.251.24.95');
  assert.equal(targets.metrics.dnsFallbacks, 1);
  assert.deepEqual(await targets.addresses('service.example'), ['142.251.24.95']);
});

test('a temporary upstream outage recovers on the next request without restarting the proxy', async () => {
  let online = false;
  const remote = await upstream((_request, socket) => {
    if (!online) { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', data => socket.end('echo:' + data.toString()));
  });
  const targets = new IPv4Targets({ lookupFn: async () => answer('93.184.216.34'),
    checkFn: async () => {},
  });
  const proxy = await createStudioIPv4Proxy({ port: 0, proxyPort: remote.port, targets });
  try {
    assert.equal((await rawRequest(proxy.server.address().port)).status, 502);
    online = true;
    assert.deepEqual(await rawRequest(proxy.server.address().port, 'recovered'), { status: 200, result: 'echo:recovered' });
    assert.deepEqual(remote.requests, ['93.184.216.34:443', '93.184.216.34:443']);
    assert.equal(proxy.metrics.failed, 1);
    assert.equal(proxy.metrics.opened, 1);
  } finally { await proxy.close(); await remote.close(); }
});

test('an interrupted application tunnel is closed, never replayed', async () => {
  const bodies = [];
  const remote = await upstream((_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', data => { bodies.push(data.toString()); socket.destroy(); });
  });
  const targets = new IPv4Targets({ lookupFn: async () => answer('93.184.216.34'), checkFn: async () => {} });
  const proxy = await createStudioIPv4Proxy({ port: 0, proxyPort: remote.port, targets });
  try {
    assert.equal((await rawRequest(proxy.server.address().port, 'one-application-request')).status, 200);
    assert.deepEqual(bodies, ['one-application-request']);
    assert.equal(remote.requests.length, 1);
  } finally { await proxy.close(); await remote.close(); }
});

test('large responses reach a slow client completely before the tunnel closes', async () => {
  const payload = Buffer.alloc(5 * 1024 * 1024, 'x');
  const remote = await upstream((_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end(payload));
  });
  const targets = new IPv4Targets({ lookupFn: async () => answer('93.184.216.34'), checkFn: async () => {} });
  const proxy = await createStudioIPv4Proxy({ port: 0, proxyPort: remote.port, targets });
  try {
    const result = await rawRequest(proxy.server.address().port, 'large-response', 100);
    assert.equal(result.status, 200);
    assert.equal(result.result.length, payload.length);
  } finally { await proxy.close(); await remote.close(); }
});

test('plain HTTP resource requests preserve their host and body without forwarding proxy credentials', async () => {
  let observed = '';
  const remote = await upstream((_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', data => {
      observed += data.toString();
      if (observed.includes('fixture-body')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
    });
  });
  const targets = new IPv4Targets({ lookupFn: async () => answer('93.184.216.34'), checkFn: async () => {} });
  const proxy = await createStudioIPv4Proxy({ port: 0, proxyPort: remote.port, targets });
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: proxy.server.address().port,
        path: 'http://service.google.com/resource?q=1', method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength('fixture-body'), 'Proxy-Authorization': 'must-not-be-forwarded' } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk.toString(); });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
      request.setTimeout(2000, () => request.destroy(new Error('HTTP proxy test timed out')));
      request.on('error', reject);
      request.end('fixture-body');
    });
    assert.deepEqual(result, { status: 200, body: 'OK' });
    assert.deepEqual(remote.requests, ['93.184.216.34:80']);
    assert.match(observed, /^POST \/resource\?q=1 HTTP\/1\.1/);
    assert.match(observed, /host: service\.google\.com/i);
    assert.match(observed, /fixture-body/);
    assert.doesNotMatch(observed, /must-not-be-forwarded|proxy-authorization/i);
  } finally { await proxy.close(); await remote.close(); }
});

test('TLS certificate verification cannot be bypassed by the address workaround', async () => {
  const certDir = path.join(root, 'test-fixtures', 'proxy-tls');
  const secure = tls.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')), ALPNProtocols: ['h2', 'http/1.1'] });
  secure.on('tlsClientError', () => {});
  const securePort = await listen(secure);
  const remote = await upstream((_request, client) => {
    const socket = net.connect(securePort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(socket); socket.pipe(client);
    });
    client.on('error', () => socket.destroy());
    client.on('close', () => socket.destroy());
    socket.on('error', () => client.destroy());
  });
  try {
    await assert.rejects(checkTargetTLS('service.example', '93.184.216.34', { proxyPort: remote.port, timeoutMs: 1500 }),
      error => /CERT|SELF_SIGNED/.test(error.code ?? ''));
  } finally { await remote.close(); await new Promise(resolve => secure.close(resolve)); }
});
