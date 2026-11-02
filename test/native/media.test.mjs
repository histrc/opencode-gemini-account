import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from '../../scripts/verify.mjs';
import { loginLabel } from '../../src/auth.mjs';
import { TEST_PNG } from '../fixtures/png.mjs';

for (const scenario of ['vision', 'image-tool', 'usage-tool']) {
  test(`actual OpenCode + offline Chromium: native ${scenario}`, { skip: !process.env.TEST_OPENCODE_EXECUTABLE || !process.env.TEST_CHROMIUM_EXECUTABLE, timeout: 120000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'gemini-native-media-'));
    try {
      const project = path.join(root, 'project'), config = path.join(root, 'config'), data = path.join(root, 'data');
      await mkdir(project); await mkdir(config); await mkdir(data);
      await writeFile(path.join(data, 'settings.json'), JSON.stringify({ experimentalTools: true, timeoutMs: 20000, loginTimeoutMs: 15000, webVisionMode: scenario === 'vision' ? 'flash-lite' : 'current' }));
      const binary = process.env.TEST_OPENCODE_EXECUTABLE;
      let version = '';
      const accept = c => { version += c; };
      await runProcess(binary, ['--version'], { stdout: accept, stderr: accept, signal: t.signal });
      const v2 = /(?:^|[^\d])2\.\d+\.\d+/.test(version);
      if (v2) {
        await mkdir(path.join(config, 'plugins', 'native-media'), { recursive: true });
        await writeFile(path.join(config, 'plugins', 'native-media', 'index.js'), `export { default } from ${JSON.stringify(new URL('../fixtures/native-plugin.mjs', import.meta.url).href)};\n`);
      }
      const model = `gemini-account/${scenario === 'vision' ? 'web-current' : 'web-tools-experimental'}`;
      const settings = {
        ...(v2 ? {} : { plugin: [new URL('../fixtures/native-plugin.mjs', import.meta.url).href] }), enabled_providers: ['gemini-account'], model, small_model: model,
        permission: { '*': 'deny', gemini_generate_image: 'allow', gemini_usage: 'allow' },
        agent: { 'media-test': { mode: 'primary', prompt: 'Use the requested tool and report its actual output.', tools: { '*': false, ...(scenario === 'image-tool' ? { gemini_generate_image: true } : scenario === 'usage-tool' ? { gemini_usage: true } : {}) } } },
      };
      if (v2) {
        delete settings.permission; delete settings.agent;
        settings.permissions = [{ action: '*', resource: '*', effect: 'deny' },
          { action: 'gemini_generate_image', resource: '*', effect: 'allow' }, { action: 'gemini_usage', resource: '*', effect: 'allow' }];
        settings.agents = { 'media-test': { mode: 'primary', system: 'Use the requested tool and report its actual output.' } };
      }
      await writeFile(path.join(config, 'opencode.json'), JSON.stringify(settings));
      const env = { ...process.env, TEST_NATIVE_SCENARIO: scenario, GEMINI_ACCOUNT_DATA_DIR: data, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data') };
      const auth = await runProcess(binary, ['auth', 'login', ...(v2 ? ['gemini-account', '--method', 'web', '--standalone'] : ['--provider', 'gemini-account', '--method', loginLabel('web')])], { env, cwd: project, timeoutMs: 60000, signal: t.signal });
      assert.equal(auth.code, 0);
      const args = ['run', ...(v2 ? ['--standalone'] : ['--dir', project]), '--model', model, '--agent', 'media-test', '--format', 'json', '--title', `Native ${scenario}`];
      args.push(scenario === 'vision' ? 'Describe this image.' : scenario === 'image-tool' ? 'Use gemini_generate_image to generate a red square.' : 'Use gemini_usage to read the actual website quota.');
      if (scenario === 'vision') { const image = path.join(project, 'fixture.png'); await writeFile(image, TEST_PNG); args.push('--file', image); }
      let output = '';
      const run = await runProcess(binary, args, { env, cwd: project, timeoutMs: 60000, signal: t.signal, stdout: part => { output += part; } });
      assert.equal(run.code, 0, output);
      const events = output.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
      assert.equal(events.some(e => e.type === 'error'), false, output);
      const text = events.filter(e => e.type === 'text').map(e => e.part.text).join('');
      if (scenario === 'vision') assert.equal(text, 'NATIVE_IMAGE_INPUT_OK');
      if (scenario === 'image-tool') {
        assert.equal(text, 'NATIVE_IMAGE_TOOL_OK');
        const tool = events.find(e => e.type === 'tool_use' && e.part.tool === 'gemini_generate_image')?.part;
        assert.equal(tool?.state.status, 'completed', output);
        const metadata = v2 ? tool.state.metadata.metadata : tool.state.metadata;
        assert.equal(metadata.images.length, 1);
        assert.equal(createHash('sha256').update(await readFile(metadata.images[0].path)).digest('hex'), createHash('sha256').update(TEST_PNG).digest('hex'));
        assert.equal(v2 ? tool.state.metadata.content.filter(c => c.type === 'file').length : tool.attachments?.length ?? tool.state.attachments?.length, 1, JSON.stringify(tool));
      }
      if (scenario === 'usage-tool') {
        assert.equal(text, 'NATIVE_USAGE_TOOL_OK');
        const tool = events.find(e => e.type === 'tool_use' && e.part.tool === 'gemini_usage')?.part;
        assert.equal(tool?.state.status, 'completed', output);
        const actual = JSON.parse(tool.state.output);
        assert.equal(actual.remaining.value, 75); assert.equal(actual.status, 'reported');
      }
    } finally {
      if (process.env.KEEP_NATIVE_FIXTURES) console.log(`# Native media artifacts: ${root}`);
      else await rm(root, { recursive: true, force: true });
    }
  });
}
