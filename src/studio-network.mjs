import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, open, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function validateIPv4Upstream(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('AI Studio IPv4 兼容模式需要无认证的 HTTP 网络代理');
  return { proxyHost: url.hostname, proxyPort: Number(url.port || 80) };
}

async function record(file, upstream) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.upstream !== upstream || !alive(state.pid) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{32}$/.test(state.instance)) return;
    const url = `http://127.0.0.1:${state.port}`;
    const response = await fetch(url + '/_aistudio_proxy/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const health = await response.json();
    if (response.ok && health.service === 'aistudio-ipv4-connect' && health.instance === state.instance) return url;
  } catch {}
}

const pending = new Map();
export async function managedStudioProxy(directory, dataDir, upstream) {
  let config;
  try { config = JSON.parse(await readFile(path.join(directory, 'managed-network.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return upstream; throw error; }
  if (config.studioIPv4 !== true) return upstream;
  validateIPv4Upstream(upstream);
  const file = path.join(dataDir, 'network-helper.json');
  if (pending.has(file)) return pending.get(file);
  const promise = ensure(file, dataDir, upstream).finally(() => pending.delete(file));
  pending.set(file, promise);
  return promise;
}

async function ensure(file, dataDir, upstream) {
  const existing = await record(file, upstream);
  if (existing) return existing;
  await mkdir(dataDir, { recursive: true });
  const lockFile = file + '.lock';
  let lock;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { lock = await open(lockFile, 'wx', 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(lockFile, 'utf8'));
        if ((pid > 0 && !alive(pid)) || (!pid && Date.now() - (await stat(lockFile)).mtimeMs > 10000)) await rm(lockFile, { force: true });
      } catch {}
      const ready = await record(file, upstream);
      if (ready) return ready;
      await delay(100);
    }
  }
  if (!lock) throw new Error('AI Studio 网络兼容组件正在启动，请稍后重试');
  try {
    const ready = await record(file, upstream);
    if (ready) return ready;
    // Reuse the old port after a helper crash so the already running backend's
    // proxy address remains valid. Never replace an occupied listener.
    let port = 0;
    try { const old = JSON.parse(await readFile(file, 'utf8')); if (old.upstream === upstream && Number.isInteger(old.port) && old.port > 0 && old.port <= 65535) port = old.port; } catch {}
    const executable = process.versions.bun ? (process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;
    const child = spawn(executable, [fileURLToPath(new URL('../scripts/studio-network.mjs', import.meta.url)), file, upstream, String(port)], { detached: true, stdio: 'ignore', windowsHide: true });
    let failure;
    child.on('error', error => { failure = error; });
    child.unref();
    for (let attempt = 0; attempt < 80; attempt++) {
      if (failure) throw failure;
      const url = await record(file, upstream);
      if (url) return url;
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error('AI Studio 网络兼容组件未能启动；请检查本机端口与网络代理');
  } finally { await lock.close(); await rm(lockFile, { force: true }); }
}
