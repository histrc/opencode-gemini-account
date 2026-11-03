import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';

export async function waitStudioReady(manager, { timeoutMs = 120000, now = Date.now, sleep = delay, onProgress = () => {} } = {}) {
  const deadline = now() + timeoutMs;
  let previous = '';
  for (;;) {
    const status = await manager.status('studio');
    const state = ['RUNNING', 'LAUNCHING', 'STOPPED', 'STOPPING', 'ERROR'].includes(status.state) ? status.state : 'unknown';
    const ready = Number.isInteger(status.accounts?.ready) ? status.accounts.ready : 0;
    const busy = Number.isInteger(status.accounts?.busy) ? status.accounts.busy : 0;
    const progress = JSON.stringify({ state, ready, busy });
    if (progress !== previous) { onProgress(progress); previous = progress; }
    if (status.status === 'running' && state === 'RUNNING' && ready > 0) return true;
    if (status.status !== 'running' || ['STOPPED', 'STOPPING', 'ERROR', 'unknown'].includes(state) || (status.accounts?.auth_required ?? 0) > 0 || now() >= deadline) return false;
    await sleep(Math.min(2000, Math.max(1, deadline - now())));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log('只读等待后端就绪，最多约两分钟；此步骤不重启、不改代理、不发送生成请求。');
    const ready = await waitStudioReady(new ManagedBackends(await loadSettings()), { onProgress: console.log });
    if (!ready) { console.error('当前后端尚未就绪，本次不发送验收请求。请提供随后生成的检查报告。'); process.exitCode = 1; }
  } catch { console.error('未能确认后端就绪，本次不发送验收请求。'); process.exitCode = 1; }
}
