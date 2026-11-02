import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../scripts/verify.mjs';

test('actual OpenCode 2 + production extension scripts: auth then a new process text round-trip', {
  skip: !process.env.TEST_OPENCODE_EXECUTABLE || !process.env.TEST_CHROMIUM_EXECUTABLE, timeout: 90000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-extension-'));
  try {
    const config = path.join(root, 'config'), data = path.join(root, 'data'), project = path.join(root, 'project');
    await mkdir(path.join(config, 'plugins', 'native-extension'), { recursive: true });
    await mkdir(data); await mkdir(project);
    await writeFile(path.join(data, 'settings.json'), JSON.stringify({ connectionMode: 'extension', timeoutMs: 15000, loginTimeoutMs: 15000 }));
    await writeFile(path.join(config, 'plugins', 'native-extension', 'index.js'), `export { default } from ${JSON.stringify(new URL('../fixtures/native-extension-plugin.mjs', import.meta.url).href)};\n`);
    await writeFile(path.join(config, 'opencode.json'), JSON.stringify({ enabled_providers: ['gemini-account'], model: 'gemini-account/studio-current', small_model: 'gemini-account/studio-current', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }));
    const env = { ...process.env, GEMINI_ACCOUNT_DATA_DIR: data, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data') };
    const binary = process.env.TEST_OPENCODE_EXECUTABLE;
    let logs = '';
    const capture = chunk => { logs += chunk; };
    const auth = await runProcess(binary, ['auth', 'login', 'gemini-account', '--method', 'studio', '--standalone'], { env, cwd: project, signal: t.signal, timeoutMs: 35000, stdout: capture, stderr: capture });
    assert.equal(auth.code, 0, logs);
    logs = '';
    const run = await runProcess(binary, ['run', '--standalone', '--model', 'gemini-account/studio-current', '--format', 'json', '--title', 'Extension offline acceptance', 'Reply OK and code.'], { env, cwd: project, signal: t.signal, timeoutMs: 35000, stdout: capture, stderr: capture });
    assert.equal(run.code, 0, logs);
    const events = logs.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(events.some(event => event.type === 'error'), false, logs);
    const text = events.filter(event => event.type === 'text').map(event => event.part.text).join('');
    assert.equal(text, 'OK\n\n```js\nconst value = 1;\n```', logs);
  } finally {
    if (process.env.KEEP_NATIVE_FIXTURES) console.log(`# Native extension artifacts: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
});
