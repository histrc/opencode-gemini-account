import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createStudioIPv4Proxy } from '../src/studio-ipv4-proxy.mjs';
import { validateIPv4Upstream } from '../src/studio-network.mjs';

const [file, upstream, requestedPort = '0'] = process.argv.slice(2);
const options = validateIPv4Upstream(upstream);
const instance = randomBytes(16).toString('hex');
const proxy = await createStudioIPv4Proxy({ ...options, instance, port: Number(requestedPort) });
const state = { pid: process.pid, port: proxy.server.address().port, instance, upstream };
const temporary = file + '.' + process.pid + '.tmp';
await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
await rename(temporary, file);
const started = Date.now();
let seenBackend = false, checking = false, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await proxy.close();
}
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    let running = false;
    try {
      const pid = Number(await readFile(path.join(path.dirname(file), 'backend.pid'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); running = true; }
    } catch {}
    if (running) seenBackend = true;
    else if (seenBackend || Date.now() - started > 300000) await close();
  } finally { checking = false; }
}, 5000);
process.on('SIGTERM', close);
process.on('SIGINT', close);
proxy.server.on('error', () => { process.exitCode = 1; void close(); });
