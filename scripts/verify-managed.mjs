import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { resolveOpenCode } from '../src/opencode-command.mjs';
import { runProcess } from './verify.mjs';

if (!process.argv.includes('--live')) throw new Error('此验收会消耗真实模型额度，请使用 --live');
const settings = await loadSettings();
const manager = new ManagedBackends(settings);
const catalog = await manager.catalog('studio', { install: true });
const model = process.env.GEMINI_ACCOUNT_VERIFY_MODEL || 'gemini-3.5-flash-lite';
if (!catalog[model]?.capabilities?.toolcall) throw new Error('后端目录未确认验收型号支持原生工具调用');
const base = path.join(settings.directory, 'managed-verification');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'baseline-'));
const project = path.join(root, 'project'), config = path.join(root, 'config');
await mkdir(project); await mkdir(path.join(config, 'plugins', 'managed-baseline'), { recursive: true });
await writeFile(path.join(config, 'plugins', 'managed-baseline', 'index.js'), `export { default } from ${JSON.stringify(new URL('../managed.mjs', import.meta.url).href)};\n`);
const token = 'NATIVE_BACKEND_OK_' + randomUUID().replaceAll('-', '');
const initial = 'module.exports.add = (a, b) => a - b;\n';
const checker = `const assert=require('node:assert/strict');const {add}=require('./calculator.cjs');assert.equal(add(7,5),12);assert.equal(add(-3,8),5);console.log('${token}');\n`;
await writeFile(path.join(project, 'calculator.cjs'), initial); await writeFile(path.join(project, 'check.cjs'), checker);
const providerModel = 'aistudio-account/' + model;
await writeFile(path.join(config, 'opencode.json'), JSON.stringify({
  enabled_providers: ['aistudio-account'], model: providerModel, small_model: providerModel,
  permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: 'calculator.cjs', effect: 'allow' }, { action: 'edit', resource: 'calculator.cjs', effect: 'allow' }, { action: 'shell', resource: 'node check.cjs', effect: 'allow' }],
  agents: { 'managed-verify': { mode: 'primary', steps: 8, system: 'Perform these tools in order: read calculator.cjs, edit calculator.cjs to repair addition, shell with exactly node check.cjs. Do not use shell for editing, and do not modify or read check.cjs. Do not skip any of the three tools. Finally report the token returned by the shell test.' } },
}));
const env = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data') };
const command = await resolveOpenCode();
let pending = '', text = '', errors = 0;
const tools = [];
const started = Date.now();
let firstTextMs;
function event(line) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (item.type === 'error') {
    errors++;
    const message = String(item.error?.message ?? item.error?.data?.message ?? item.error?.name ?? item.error?.type ?? 'unknown').slice(0, 500).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
    console.log(`模型请求未完成：${message}`);
  }
  if (item.type === 'text') { firstTextMs ??= Date.now() - started; text += item.part?.text ?? ''; }
  if (item.type === 'tool_use' && item.part?.state?.status === 'completed') {
    tools.push({ name: item.part.tool, exit: item.part.state.metadata?.metadata?.exit ?? item.part.state.metadata?.exit, testToken: item.part.state.output?.includes(token) ?? false });
    console.log(`原生工具 ${item.part.tool} 已完成`);
  }
}
console.log('开始真实 OpenCode 原生工具闭环（仅在临时测试项目操作）。');
const run = await runProcess(command.file, [...command.prefix, 'run', '--standalone', '--model', providerModel, '--agent', 'managed-verify', '--format', 'json', '--title', 'Managed backend baseline', 'Use read on calculator.cjs, then edit to fix addition, then shell to run exactly node check.cjs. Report the actual test token.'], {
  env, cwd: project, timeoutMs: 240000,
  stdout(chunk) { pending += chunk; let index; while ((index = pending.indexOf('\n')) >= 0) { event(pending.slice(0, index)); pending = pending.slice(index + 1); } },
});
if (pending.trim()) event(pending);
const hash = value => createHash('sha256').update(value).digest('hex');
const checkerUnchanged = hash(await readFile(path.join(project, 'check.cjs'))) === hash(checker);
const fileChanged = hash(await readFile(path.join(project, 'calculator.cjs'))) !== hash(initial);
let independent = false;
if (checkerUnchanged && fileChanged) {
  let output = '';
  const check = await runProcess(process.execPath, ['check.cjs'], { cwd: project, stdout: chunk => { output += chunk; } });
  independent = check.code === 0 && output.trim() === token;
}
const report = { mode: 'real-google-native-backend', model, elapsedMs: Date.now() - started, firstTextMs, hostExit: run.code, errors, tools,
  checks: { read: tools.some(t => t.name === 'read'), edit: tools.some(t => t.name === 'edit'), shell: tools.some(t => t.name === 'shell' && t.exit === 0 && t.testToken), checkerUnchanged, fileChanged, independent, finalToken: text.includes(token) } };
report.passed = run.code === 0 && errors === 0 && Object.values(report.checks).every(Boolean);
const reportPath = path.join(root, 'report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); console.log(`报告：${reportPath}`);
if (!report.passed) process.exitCode = 1;
