import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { publishWithRetry, prepareCamoufox } from '../src/camoufox-install.mjs';
import { CAMOUFOX_VERSION } from '../vendor/magpie/lib/studio-native.mjs';
import { createSetupProgress } from '../src/setup-progress.mjs';
import { studioConnectionError } from '../src/managed-backends.mjs';

test('Windows publish retries temporary file locks without downloading or deleting the old target', async () => {
  let calls = 0, waits = 0;
  await publishWithRetry('stage', 'target', {
    renameFn: async () => { if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EACCES' }); },
    sleep: async () => { waits++; },
  });
  assert.equal(calls, 3); assert.equal(waits, 2);
  await assert.rejects(publishWithRetry('stage', 'target', {
    renameFn: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    sleep: async () => {}, attempts: 2,
  }), error => error.code === 'CAMOUFOX_PUBLISH_FAILED');
});

test('matching existing Camoufox skips all download and extraction work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'camoufox-ready-'));
  try {
    const runtime = path.join(directory, 'runtime', 'camoufox');
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, 'camoufox.exe'), 'fixture, never executed');
    await writeFile(path.join(runtime, 'application.ini'), `[App]\nVersion=${CAMOUFOX_VERSION}\n`);
    const states = [];
    await prepareCamoufox(directory, { platform: 'win32', onProgress: state => states.push(state) });
    assert.deepEqual(states.map(state => state.phase), ['browser-ready']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('progress page reports byte counts and errors through a secret loopback URL and CLI state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'setup-progress-'));
  const progress = await createSetupProgress(directory);
  try {
    progress.report({ phase: 'browser-download', detail: 'downloading fixture', received: 50, total: 100 });
    const response = await fetch(progress.url + '/status');
    const state = await response.json();
    assert.equal(state.steps[1].received, 50); assert.equal(state.steps[1].total, 100);
    assert.equal(state.steps[1].state, 'active');
    assert.equal((await fetch(new URL('/other/status', progress.url))).status, 404);
    await progress.finish(Object.assign(new Error('下载中断，进度已保留'), { code: 'CAMOUFOX_DOWNLOAD_FAILED' }));
    const saved = JSON.parse(await readFile(path.join(directory, 'setup-studio-progress.json'), 'utf8'));
    assert.equal(saved.error, '下载中断，进度已保留');
    assert.equal(saved.steps[1].state, 'failed');
    assert.ok(saved.updatedAt > 0);
  } finally { progress.close(); await rm(directory, { recursive: true, force: true }); }
});

test('account lease conflict appears on both the progress page and persisted CLI state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-lease-progress-'));
  const progress = await createSetupProgress(directory);
  try {
    progress.report({ phase: 'generation', detail: 'starting' });
    const error = studioConnectionError(new Error('WAA runtime 由其他进程占用: fixture@example.invalid'));
    await progress.finish(error);
    const page = await (await fetch(progress.url + '/status')).json();
    const saved = JSON.parse(await readFile(path.join(directory, 'setup-studio-progress.json'), 'utf8'));
    assert.equal(page.error, error.message);
    assert.equal(saved.error, error.message);
    assert.equal(page.steps[3].state, 'failed');
    assert.ok(!JSON.stringify(saved).includes('fixture@example.invalid'));
  } finally { progress.close(); await rm(directory, { recursive: true, force: true }); }
});
