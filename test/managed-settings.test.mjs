import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings } from '../src/managed-settings.mjs';
import { install } from '../scripts/install.mjs';

test('desktop and CLI resolve the same pinned data directory after installing the managed entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-install-location-'));
  const previous = process.env.GEMINI_ACCOUNT_DATA_DIR;
  delete process.env.GEMINI_ACCOUNT_DATA_DIR;
  try {
    const entry = path.join(directory, 'managed.mjs');
    await writeFile(entry, 'export default {};');
    const dataDir = path.join(directory, 'shared-data');
    await install({ configDir: path.join(directory, 'config'), v2: true, entry, dataDir });
    const installationURL = new URL('./.managed-install.json', 'file:///' + entry.replaceAll('\\', '/').replace(/^\//, ''));
    assert.equal((await loadSettings({ installationURL })).directory, dataDir);
    await writeFile(installationURL, JSON.stringify({ dataDirectory: 'relative/path' }));
    await assert.rejects(loadSettings({ installationURL }), /绝对路径/);
    process.env.GEMINI_ACCOUNT_DATA_DIR = dataDir;
    assert.equal((await loadSettings({ installationURL })).directory, dataDir);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_ACCOUNT_DATA_DIR;
    else process.env.GEMINI_ACCOUNT_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
