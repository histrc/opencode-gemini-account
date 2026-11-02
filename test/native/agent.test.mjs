import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAgent } from '../../scripts/verify.mjs';
import { validateSettings } from '../../src/settings.mjs';

for (const backend of ['web', 'studio']) {
  test(`actual OpenCode + offline Chromium: ${backend} read → edit → bash → answer`, {
    skip: !process.env.TEST_OPENCODE_EXECUTABLE || !process.env.TEST_CHROMIUM_EXECUTABLE,
    timeout: 90000,
  }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gemini-native-'));
    try {
      const raw = { experimentalTools: true, timeoutMs: 15000, loginTimeoutMs: 15000 };
      await writeFile(path.join(directory, 'settings.json'), JSON.stringify(raw));
      const settings = validateSettings(raw, directory);
      const { report } = await verifyAgent({
        settings, backend, upstreamModel: backend === 'studio' ? 'gemini-3.5-flash-lite' : undefined,
        executable: process.env.TEST_OPENCODE_EXECUTABLE,
        pluginURL: new URL('../fixtures/native-plugin.mjs', import.meta.url).href,
        onProgress: message => process.stdout.write(`# ${message}\n`), timeoutMs: 75000, signal: t.signal,
      });
      assert.deepEqual(report.checks, { authenticated: true, read: true, edit: true, bash: true, checkerUnchanged: true, fileChanged: true, independentCheck: true, finalReply: true }, JSON.stringify(report));
      assert.equal(report.passed, true);
      assert.deepEqual(report.tools.map(t => t.tool), ['read', 'edit', report.executionTool]);
    } finally {
      if (process.env.KEEP_NATIVE_FIXTURES) console.log(`# Test artifacts: ${directory}`);
      else await rm(directory, { recursive: true, force: true });
    }
  });
}
