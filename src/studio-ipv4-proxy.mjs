import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

// Reused from this workspace's earlier Windows deployment. No Magpie runtime
// dependency: DNS and TLS checks run locally and the configured upstream carries
// the original end-to-end TLS tunnel.
export const allowedGoogleTarget = (host, port) => [80, 443].includes(port) &&
  ['google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com'].some(domain => host === domain || host.endsWith('.' + domain));
const unavailable = (message, code = 'PROXY_UNAVAILABLE') => Object.assign(new Error(message), { code });
const usableIPv4 = ip => net.isIPv4(ip) && !/^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|198\.(?:18|19)\.)/.test(ip);

// Ask the upstream proxy for an IP, rather than asking its exit server to resolve a hostname.
// TLS stays end-to-end: the application still sends the hostname and checks Google's certificate.
export function connectViaProxy(ip, port, { proxyHost = '127.0.0.1', proxyPort = 7897, timeoutMs = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(unavailable('Upstream CONNECT timed out')), timeoutMs);
    function fail(error) {
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.destroy();
      reject(error);
    }
    socket.once('error', fail);
    socket.once('connect', () => socket.write(`CONNECT ${ip}:${port} HTTP/1.1\r\nHost: ${ip}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 32768) return fail(unavailable('Invalid upstream CONNECT response'));
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(buffer.toString('ascii', 0, boundary))) {
        return fail(unavailable('Upstream proxy rejected CONNECT'));
      }
      clearTimeout(timer);
      socket.removeListener('error', fail);
      socket.removeAllListeners('data');
      const remaining = buffer.subarray(boundary + 4);
      if (remaining.length) socket.unshift(remaining);
      socket.setKeepAlive(true, 10000);
      socket.pause();
      resolve(socket);
    });
    socket.once('end', () => { if (buffer.indexOf('\r\n\r\n') < 0) fail(unavailable('Upstream proxy closed CONNECT')); });
  });
}

export async function checkTargetTLS(host, ip, options) {
  const raw = await connectViaProxy(ip, 443, options);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true,
      ALPNProtocols: ['h2', 'http/1.1'] });
    const timer = setTimeout(() => finish(unavailable('Target TLS handshake timed out')), options.timeoutMs ?? 7000);
    const finish = error => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once('secureConnect', () => finish());
    socket.once('error', finish);
  });
}

async function dnsOverHTTPS(host, options) {
  const resolvers = [
    { ip: '8.8.8.8', host: 'dns.google', route: '/resolve?name=' + encodeURIComponent(host) + '&type=A' },
    { ip: '1.1.1.1', host: 'cloudflare-dns.com', route: '/dns-query?name=' + encodeURIComponent(host) + '&type=A' },
  ];
  for (const resolver of resolvers) {
    try {
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (_settings, callback) => {
        connectViaProxy(resolver.ip, 443, options).then(raw => {
          const socket = tls.connect({ socket: raw, servername: resolver.host, rejectUnauthorized: true,
            ALPNProtocols: ['http/1.1'] });
          let completed = false;
          const finish = error => {
            if (completed) return;
            completed = true;
            socket.setTimeout(0);
            callback(error, error ? undefined : socket);
          };
          socket.setTimeout(8000, () => socket.destroy(unavailable('DNS TLS handshake timed out')));
          socket.once('secureConnect', () => finish(null));
          socket.once('error', finish);
        }, error => callback(error));
      };
      try {
        return await new Promise((resolve, reject) => {
          const request = https.get({ hostname: resolver.host, path: resolver.route, agent,
            headers: { Accept: 'application/dns-json' } }, response => {
            const chunks = [];
            let length = 0;
            response.on('data', chunk => {
              length += chunk.length;
              if (length > 65536) response.destroy(unavailable('DNS response too large'));
              else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
              if (response.statusCode !== 200) return reject(unavailable('DNS HTTPS response failed'));
              try {
                const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!result.Answer?.some(record => record.type === 1 && usableIPv4(record.data))) {
                  reject(unavailable('DNS HTTPS resolver returned no public IPv4 address'));
                } else resolve(result);
              }
              catch { reject(unavailable('Invalid DNS HTTPS response')); }
            });
          });
          const timer = setTimeout(() => request.destroy(unavailable('DNS HTTPS request timed out')), 10000);
          request.once('close', () => clearTimeout(timer));
          request.once('error', reject);
        });
      } finally { agent.destroy(); }
    } catch {}
  }
  throw unavailable('No DNS resolver could be reached', 'DNS_UNAVAILABLE');
}

export class IPv4Targets {
  constructor(options = {}) {
    this.options = options;
    this.dns = new Map();
    this.health = new Map();
    this.pending = new Map();
    this.lookupPending = new Map();
    this.now = options.now ?? Date.now;
    this.lookupFn = options.lookupFn ?? (host => this.lookupLocal(host));
    this.alternateLookupFn = options.alternateLookupFn ?? (options.lookupFn ? null : host => dnsOverHTTPS(host, this.options));
    this.checkFn = options.checkFn ?? ((host, ip) => checkTargetTLS(host, ip, this.options));
    this.metrics = { dnsQueries: 0, dnsCacheHits: 0, dnsFallbacks: 0, targetChecks: 0, targetFailures: 0 };
  }
  async lookupLocal(host) {
    try {
      const file = this.options.controllerConfigFile ?? path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml');
      const config = fs.readFileSync(file, 'utf8');
      let secret = config.match(/^secret:\s*(.*)$/m)?.[1]?.trim() ?? '';
      if ([39, 34].includes(secret.charCodeAt(0))) secret = secret.slice(1, -1);
      const endpoint = config.match(/^external-controller:\s*(\S+)$/m)?.[1] ?? '127.0.0.1:9097';
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw unavailable('Local DNS controller is not on loopback');
      const response = await fetch(`http://${endpoint}/dns/query?name=${encodeURIComponent(host)}&type=A`, {
        headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw unavailable('Local DNS controller is unavailable');
      const result = await response.json();
      if (!result.Answer?.some(record => record.type === 1 && usableIPv4(record.data))) throw unavailable('Local DNS returned no public IPv4 address');
      return result;
    } catch {
      this.metrics.dnsFallbacks++;
      return dnsOverHTTPS(host, this.options);
    }
  }
  async addresses(host) {
    if (net.isIPv4(host)) {
      if (!usableIPv4(host)) throw unavailable('Only public IPv4 targets are accepted', 'INVALID_TARGET');
      return [host];
    }
    if (net.isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(host)) {
      throw unavailable('A public hostname is required', 'INVALID_TARGET');
    }
    const cached = this.dns.get(host);
    if (cached && cached.expires > this.now()) { this.metrics.dnsCacheHits++; return cached.ips; }
    if (this.lookupPending.has(host)) return this.lookupPending.get(host);
    const pending = (async () => {
      this.metrics.dnsQueries++;
      const result = await this.lookupFn(host);
      const records = (result.Answer ?? []).filter(record => record.type === 1 && usableIPv4(record.data));
      const ips = [...new Set(records.map(record => record.data))];
      if (!ips.length) throw unavailable('No public IPv4 address found', 'DNS_UNAVAILABLE');
      const ttl = Math.max(5, Math.min(300, ...records.map(record => Number(record.TTL) || 30)));
      this.dns.set(host, { ips, expires: this.now() + ttl * 1000 });
      if (this.dns.size > 256) this.dns.delete(this.dns.keys().next().value);
      return ips;
    })().finally(() => this.lookupPending.delete(host));
    this.lookupPending.set(host, pending);
    return pending;
  }
  async target(host, port) {
    const key = `${host}:${port}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.choose(host, port).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
  async choose(host, port) {
    const ips = await this.addresses(host);
    const healthKey = `${host}:${port}`;
    const current = this.health.get(healthKey);
    if (current && current.expires > this.now() && ips.includes(current.ip)) return current.ip;
    let error;
    const checked = new Set();
    const tryAddresses = async addresses => {
      for (const ip of addresses.slice(0, 4)) {
        if (checked.has(ip)) continue;
        checked.add(ip);
        try {
          if (port === 443 && !net.isIP(host)) {
            this.metrics.targetChecks++;
            await this.checkFn(host, ip);
          }
          this.health.set(healthKey, { ip, expires: this.now() + 60000 });
          if (this.health.size > 256) this.health.delete(this.health.keys().next().value);
          return ip;
        } catch (caught) { error = caught; this.metrics.targetFailures++; }
      }
    };
    let reachable = await tryAddresses(ips);
    if (reachable) return reachable;
    if (this.alternateLookupFn && !net.isIP(host)) {
      try {
        this.metrics.dnsFallbacks++;
        const result = await this.alternateLookupFn(host);
        const records = (result.Answer ?? []).filter(record => record.type === 1 && usableIPv4(record.data));
        const alternatives = [...new Set(records.map(record => record.data))];
        reachable = await tryAddresses(alternatives);
        if (reachable) {
          const ttl = Math.max(5, Math.min(300, ...records.map(record => Number(record.TTL) || 30)));
          this.dns.set(host, { ips: alternatives, expires: this.now() + ttl * 1000 });
          return reachable;
        }
      } catch (caught) { error = caught; }
    }
    this.dns.delete(host);
    throw error ?? unavailable('No target address is reachable');
  }
  invalidate(host) { this.health.delete(`${host}:443`); this.health.delete(`${host}:80`); }
}

export async function createStudioIPv4Proxy(options = {}) {
  const targets = options.targets ?? new IPv4Targets(options);
  const sockets = new Set();
  const metrics = { opened: 0, failed: 0, active: 0, earlyCloses: 0 };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/_aistudio_proxy/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ service: 'aistudio-ipv4-connect', version: 1, instance: options.instance, ...metrics, ...targets.metrics }));
      return;
    }
    let raw;
    try {
      const target = new URL(request.url);
      const port = Number(target.port || 80);
      if (target.protocol !== 'http:' || target.username || target.password || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw unavailable('Unsupported HTTP proxy target', 'INVALID_TARGET');
      }
      if (!allowedGoogleTarget(target.hostname.toLowerCase(), port)) throw unavailable('Target is not a Google service', 'INVALID_TARGET');
      const ip = await targets.target(target.hostname, port);
      if (request.destroyed || response.destroyed) return;
      raw = await connectViaProxy(ip, port, options);
      sockets.add(raw);
      metrics.opened++;
      metrics.active++;
      raw.once('close', () => { sockets.delete(raw); metrics.active--; });
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => raw;
      const headers = { ...request.headers, host: target.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const outbound = http.request({ hostname: target.hostname, port, method: request.method,
        path: target.pathname + target.search, agent, headers }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.on('error', () => response.destroy());
        upstreamResponse.once('end', () => agent.destroy());
        upstreamResponse.pipe(response);
      });
      outbound.on('error', () => {
        agent.destroy();
        targets.invalidate(target.hostname);
        if (!response.headersSent) { response.writeHead(502); response.end('Upstream connection failed'); }
        else response.destroy();
      });
      request.once('aborted', () => outbound.destroy());
      response.once('close', () => { if (!response.writableEnded) outbound.destroy(); });
      request.pipe(outbound);
      raw.resume();
    } catch {
      metrics.failed++;
      raw?.destroy();
      if (!response.headersSent) response.writeHead(502);
      response.end('Upstream connection failed');
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('connect', async (request, client, head) => {
    let host;
    let upstream;
    let established = false;
    try {
      const target = new URL('http://' + request.url);
      host = target.hostname.toLowerCase();
      const port = Number(target.port || 80);
      if (target.username || target.password || target.pathname !== '/' || target.search || target.hash ||
          !Number.isInteger(port) || port < 1 || port > 65535) throw unavailable('Unsupported CONNECT target', 'INVALID_TARGET');
      if (!allowedGoogleTarget(host, port)) throw unavailable('Target is not a Google service', 'INVALID_TARGET');
      const ip = await targets.target(host, port);
      if (client.destroyed) return;
      upstream = await connectViaProxy(ip, port, options);
      if (client.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => { targets.invalidate(host); client.destroy(); });
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('end', () => client.end());
      let received = 0;
      const openedAt = Date.now();
      upstream.on('data', chunk => { received += chunk.length; });
      upstream.once('close', () => {
        metrics.active--;
        if (received < 256 && client.bytesRead > 0 && Date.now() - openedAt < 3000) {
          targets.invalidate(host); metrics.earlyCloses++;
        }
        client.end();
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      metrics.opened++;
      metrics.active++;
      established = true;
      client.pipe(upstream);
      upstream.pipe(client);
    } catch (error) {
      metrics.failed++;
      if (host) targets.invalidate(host);
      upstream?.destroy();
      if (!client.destroyed && !established) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      options.onFailure?.({ host, code: error.code ?? 'CONNECTION_FAILED' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7898, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return { server, targets, metrics,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }),
  };
}
