import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configure } from '../scripts/configure.mjs';
import { validateSettings } from '../src/settings.mjs';
import { resolveModel, modelCatalog } from '../src/models.mjs';
import { classifyPageError } from '../src/errors.mjs';

test('configured Studio models are allowlisted; disabled tool entries stay disabled', () => {
  const settings = validateSettings({ studioModels: ['gemini-example', 'gemini-example-v2'] });
  assert.equal(resolveModel('studio-gemini-example', settings).upstreamModel, 'gemini-example');
  assert.throws(() => resolveModel('studio-gemini-unconfigured', settings), /尚未配置/);
  assert.throws(() => resolveModel('studio-gemini-example-tools-experimental', settings), /experimentalTools/);
  assert.equal(modelCatalog(settings)['studio-gemini-example'].tools, false);
  for (const studioModels of [['https://evil.example'], ['gemini-x', 'gemini-x'], ['gemini-x-tools-experimental'], ['gemini-x?key=secret']]) {
    assert.throws(() => validateSettings({ studioModels }));
  }
  assert.equal(validateSettings().studioSearch, 'off');
  assert.equal(validateSettings({ studioSearch: 'current' }).studioSearch, 'current');
  for (const studioSearch of [true, false, 'on', 0]) assert.throws(() => validateSettings({ studioSearch }));
});

test('selector configuration cannot write through inherited backend keys', () => {
  const raw = JSON.parse('{"selectors":{"__proto__":{"input":["malicious-selector"]}}}');
  assert.throws(() => validateSettings(raw), /未知 selectors/);
  assert.equal(Object.prototype.input, undefined);
});

test('page error classifications do not leak raw upstream account or prompt text', () => {
  for (const [text, code] of [
    ['Permission denied for private-account-marker', 'permission_denied'],
    ['Quota exceeded: private-prompt-marker', 'quota_limited'],
    ['Model unavailable: private-account-marker', 'model_unavailable'],
    ['Unexpected failure: private-prompt-marker', 'upstream_ui_error'],
  ]) {
    const error = classifyPageError(text);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private-/);
  }
});

test('configuration updates preserve unrelated settings and refuse corrupt originals', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-config-'));
  try {
    const file = path.join(directory, 'settings.json');
    const raw = { proxy: 'http://127.0.0.1:7890', selectors: { web: { input: ['#custom-input'] } } };
    await writeFile(file, JSON.stringify(raw));
    await configure(directory, { experimentalTools: true, keepLastPage: false });
    const actual = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(actual.proxy, raw.proxy);
    assert.deepEqual(actual.selectors, raw.selectors);
    assert.equal(actual.experimentalTools, true);
    assert.equal(actual.keepLastPage, false);
    await writeFile(file, 'corrupt JSON');
    await assert.rejects(configure(directory, { browser: 'msedge' }), /未覆盖原文件/);
    assert.equal(await readFile(file, 'utf8'), 'corrupt JSON');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configuration CLI writes valid settings and lists newly registered model IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-cli-'));
  try {
    const output = execFileSync(process.execPath, ['scripts/configure.mjs', '--browser', 'msedge', '--tools', 'on', '--studio-model', 'gemini-example', '--studio-search', 'current', '--web-vision-mode', 'flash-lite', '--timeout-seconds', '420'], {
      cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, GEMINI_ACCOUNT_DATA_DIR: directory }, encoding: 'utf8',
    });
    const actual = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
    assert.equal(actual.timeoutMs, 420000);
    assert.equal(actual.browser, 'msedge');
    assert.equal(actual.studioSearch, 'current');
    assert.equal(actual.webVisionMode, 'flash-lite');
    assert.ok(actual.studioModels.includes('gemini-example'));
    assert.match(output, /studio-gemini-example-tools-experimental/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
