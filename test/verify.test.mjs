import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOpenCode } from '../src/opencode-command.mjs';
import { runProcess } from '../scripts/verify.mjs';

test('Windows npm and native OpenCode launchers resolve without shell interpolation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini npm 中文 空格 '));
  try {
    const launcher = path.join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode');
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, '// fake npm launcher');
    await writeFile(path.join(directory, 'opencode.cmd'), '@echo off');
    const options = { platform: 'win32', env: { PATH: directory } };
    assert.deepEqual(await resolveOpenCode('opencode', options), { file: process.execPath, prefix: [launcher] });
    await writeFile(path.join(directory, 'opencode.exe'), 'fake executable');
    assert.deepEqual(await resolveOpenCode('opencode', options), { file: path.join(directory, 'opencode.exe'), prefix: [] });
    await assert.rejects(resolveOpenCode('missing', options), /未找到/);
    const desktopCLI = path.join(directory, 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe');
    await mkdir(path.dirname(desktopCLI), { recursive: true });
    await writeFile(desktopCLI, 'fake desktop CLI');
    assert.deepEqual(await resolveOpenCode('opencode', { platform: 'win32', env: { LOCALAPPDATA: directory, PATH: '' } }), { file: desktopCLI, prefix: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verification process deadline and cancellation terminate waiting processes', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /超时/);
  const controller = new AbortController();
  const waiting = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(new Error('cancel-verification'));
  await assert.rejects(waiting, /cancel-verification/);
});
