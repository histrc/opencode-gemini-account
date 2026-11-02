import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from '../scripts/install.mjs';

test('installer loads from paths with spaces and Chinese, preserves config, and uninstalls only its wrapper', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-install-'));
  try {
    const source = path.join(root, '源码 directory'); await mkdir(source);
    const entry = path.join(source, 'index.mjs'); await writeFile(entry, 'export default async () => ({ config: async () => {} });');
    const configDir = path.join(root, 'config'); await mkdir(configDir);
    const configFile = path.join(configDir, 'opencode.jsonc');
    await writeFile(configFile, '// preserved comment\n{"plugin":["other-plugin"]}');
    const target = await install({ configDir, entry });
    const plugin = await import(pathToFileURL(target).href);
    assert.equal(typeof (await plugin.default()).config, 'function');
    assert.equal(await readFile(configFile, 'utf8'), '// preserved comment\n{"plugin":["other-plugin"]}');
    await install({ configDir, entry }); // Idempotent.
    await install({ configDir, uninstall: true });
    await assert.rejects(access(target));
    await access(configFile);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer and uninstaller refuse to overwrite an unrelated plugin', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'gemini-conflict-'));
  try {
    await mkdir(path.join(configDir, 'plugins'));
    const target = path.join(configDir, 'plugins', 'gemini-account.js');
    await writeFile(target, 'export default () => "unrelated";');
    await assert.rejects(install({ configDir }), /不是本安装器/);
    await assert.rejects(install({ configDir, uninstall: true }), /不是本安装器/);
    assert.equal(await readFile(target, 'utf8'), 'export default () => "unrelated";');
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('V2 installs a discoverable directory and preserves global configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-v2-install-'));
  try {
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, 'export default { id: "fixture", setup() {} };');
    const configFile = path.join(root, 'opencode.json');
    await writeFile(configFile, '{"plugins":["existing"]}');
    const target = await install({ configDir: root, entry, v2: true });
    assert.equal(target, path.join(root, 'plugins', 'gemini-account', 'index.js'));
    assert.equal((await import(pathToFileURL(target).href)).default.id, 'fixture');
    assert.equal(await readFile(configFile, 'utf8'), '{"plugins":["existing"]}');
    await install({ configDir: root, entry, v2: true });
    await install({ configDir: root, v2: true, uninstall: true });
    await assert.rejects(access(target));
  } finally { await rm(root, { recursive: true, force: true }); }
});
