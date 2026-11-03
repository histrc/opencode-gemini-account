import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertPreviewDirectory } from '../src/backend-preview.mjs';

test('backend preview refuses to migrate a stable installation or an existing unversioned account directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'backend-preview-'));
  try {
    const stable = path.join(root, 'stable'), unversioned = path.join(root, 'unversioned');
    await mkdir(stable); await mkdir(path.join(unversioned, 'auth'), { recursive: true });
    const manifest = '{"version":"0.2.18-magpie.1"}';
    await writeFile(path.join(stable, 'install-manifest.json'), manifest);
    for (const directory of [stable, unversioned]) await assert.rejects(assertPreviewDirectory(directory, '0.2.19'), error => error.code === 'STUDIO_PREVIEW_EXISTING_INSTALL');
    assert.equal(await readFile(path.join(stable, 'install-manifest.json'), 'utf8'), manifest);
    await assertPreviewDirectory(path.join(root, 'new'), '0.2.19');
    const current = path.join(root, 'current'); await mkdir(current);
    await writeFile(path.join(current, 'install-manifest.json'), '{"version":"0.2.19"}');
    await assertPreviewDirectory(current, '0.2.19');
  } finally { await rm(root, { recursive: true, force: true }); }
});
