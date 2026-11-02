import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { resolveOpenCode } from '../src/opencode-command.mjs';
import { runProcess } from './verify.mjs';
import { compareNativeRequest } from '../src/managed-diagnostics.mjs';
import { studioChatMode } from '../src/studio-chat-mode.mjs';

if (!process.argv.includes('--live')) throw new Error('此验收会消耗真实模型额度，请使用 --live');
const diagnose = process.argv.includes('--diagnose-request');
const settings = await loadSettings();
const chatMode = await studioChatMode(settings.directory);
const manager = new ManagedBackends(settings);
const catalog = await manager.catalog('studio', { install: true });
const model = process.env.GEMINI_ACCOUNT_VERIFY_MODEL || 'gemini-3.5-flash-lite';
if (!catalog[model]?.capabilities?.toolcall) throw new Error('后端目录未确认验收型号支持原生工具调用');
const base = path.join(settings.directory, 'managed-verification');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'baseline-'));
const project = path.join(root, 'project'), config = path.join(root, 'config');
await mkdir(project); await mkdir(path.join(config, 'plugins', 'managed-baseline'), { recursive: true });
const capturedFile = path.join(root, 'private-request.json');
const managedURL = new URL('../managed.mjs', import.meta.url).href;
const captureWrapper = `import { ManagedBackends } from ${JSON.stringify(new URL('../src/managed-backends.mjs', import.meta.url).href)};
import { writeFile } from 'node:fs/promises';
ManagedBackends.prototype.fetch = async function(backend, input, init) {
  if (backend === 'studio' && new URL(input).pathname === '/v1/chat/completions') {
    await writeFile(${JSON.stringify(capturedFile)}, init.body, { flag: 'wx', mode: 0o600 });
  }
  return Response.json({error:{message:'Local diagnostic capture; not sent upstream'}},{status:400});
};
export { default } from ${JSON.stringify(managedURL)};\n`;
await writeFile(path.join(config, 'plugins', 'managed-baseline', 'index.js'), diagnose ? captureWrapper : `export { default } from ${JSON.stringify(managedURL)};\n`);
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
const env = { ...process.env, GEMINI_ACCOUNT_DATA_DIR: settings.directory, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data') };
const command = await resolveOpenCode();
let pending = '', text = '', errors = 0;
const tools = [];
const started = Date.now();
let firstTextMs;
function event(line) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (item.type === 'error' && !diagnose) {
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
console.log(diagnose ? '正在截取临时项目的 OpenCode 首轮请求；截取阶段不发生成请求、不执行工具。' : `开始真实 OpenCode 原生工具闭环（仅在临时测试项目操作；chatMode=${chatMode}）。`);
const run = await runProcess(command.file, [...command.prefix, 'run', '--standalone', '--model', providerModel, '--agent', 'managed-verify', '--format', 'json', '--title', 'Managed backend baseline', 'Use read on calculator.cjs, then edit to fix addition, then shell to run exactly node check.cjs. Report the actual test token.'], {
  env, cwd: project, timeoutMs: 240000,
  stdout(chunk) { pending += chunk; let index; while ((index = pending.indexOf('\n')) >= 0) { event(pending.slice(0, index)); pending = pending.slice(index + 1); } },
});
if (pending.trim()) event(pending);
if (diagnose) {
  let request;
  try {
    if ((await stat(capturedFile)).size > 2 * 1024 * 1024) throw new Error('诊断请求超过大小限制');
    request = JSON.parse(await readFile(capturedFile, 'utf8'));
  } finally { await rm(capturedFile, { force: true }); }
  let version = '';
  const acceptVersion = chunk => { version += chunk; };
  await runProcess(command.file, [...command.prefix, '--version'], { stdout: acceptVersion, stderr: acceptVersion });
  console.log(JSON.stringify({ hostVersion: /\b\d+\.\d+\.\d+\b/.exec(version)?.[0] ?? 'unknown', model: request.model, stream: request.stream === true,
    outputLimit: request.max_completion_tokens ?? request.max_tokens ?? null, toolCount: request.tools?.length ?? 0, messageCount: request.messages?.length ?? 0 }));
  console.log('将对实际首轮请求逐项对照，最多六条生成请求；遇到首个可接受版本即停止。不执行模型返回的工具，不改正式请求策略。');
  const report = await compareNativeRequest(manager, request, row => console.log(JSON.stringify(row)));
  console.log(JSON.stringify({ conclusion: report.conclusion, candidateDifference: report.candidateDifference }));
  console.log('单次对照不能排除服务状态变化；ACCEPTED 不代表编程闭环成功。原始请求已从临时文件移除，结果不自动上传。');
  if (!report.results.some(row => row.result === 'ACCEPTED')) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const checkerUnchanged = hash(await readFile(path.join(project, 'check.cjs'))) === hash(checker);
const fileChanged = hash(await readFile(path.join(project, 'calculator.cjs'))) !== hash(initial);
let independent = false;
if (checkerUnchanged && fileChanged) {
  let output = '';
  const check = await runProcess(process.execPath, ['check.cjs'], { cwd: project, stdout: chunk => { output += chunk; } });
  independent = check.code === 0 && output.trim() === token;
}
const report = { mode: 'real-google-native-backend', chatMode, model, elapsedMs: Date.now() - started, firstTextMs, hostExit: run.code, errors, tools,
  checks: { read: tools.some(t => t.name === 'read'), edit: tools.some(t => t.name === 'edit'), shell: tools.some(t => t.name === 'shell' && t.exit === 0 && t.testToken), checkerUnchanged, fileChanged, independent, finalToken: text.includes(token) } };
report.passed = run.code === 0 && errors === 0 && Object.values(report.checks).every(Boolean);
const reportPath = path.join(root, 'report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); console.log(`报告：${reportPath}`);
if (!report.passed) process.exitCode = 1;
