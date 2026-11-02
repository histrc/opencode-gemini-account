import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loginLabel } from '../src/auth.mjs';
import { loadSettings, PROVIDER } from '../src/settings.mjs';
import { resolveModel, isStudioModelID } from '../src/models.mjs';
import { resolveOpenCode } from '../src/opencode-command.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const entryURL = new URL('../index.mjs', import.meta.url).href;

// Exported for an offline host integration test. The CLI always uses the
// production plugin; there is no CLI switch that substitutes a mock browser.
export async function verifyAgent({ settings, backend, upstreamModel, executable = 'opencode', pluginURL = entryURL, onProgress = console.log, timeoutMs = settings.timeoutMs * 5, signal }) {
  if (!['web', 'studio'].includes(backend)) throw new Error('入口必须是 web 或 studio');
  if (upstreamModel && (backend !== 'studio' || !isStudioModelID(upstreamModel))) throw new Error('仅 Studio 支持 --studio-model Gemini型号ID');
  const model = backend === 'web' ? 'web-tools-experimental' : upstreamModel ? `studio-${upstreamModel}-tools-experimental` : 'studio-tools-experimental';
  resolveModel(model, settings);
  const command = await resolveOpenCode(executable);
  let hostVersion = '';
  const acceptVersion = c => { hostVersion += c; };
  const versionCheck = await runProcess(command.file, [...command.prefix, '--version'], { timeoutMs: 10000, signal, stdout: acceptVersion, stderr: acceptVersion });
  const parsedVersion = hostVersion.match(/(?:^|[^\d])([12])\.\d+\.\d+/);
  if (versionCheck.code !== 0 || !parsedVersion) throw new Error('无法确认 OpenCode 1.x/2.x 版本');
  const v2 = parsedVersion[1] === '2';
  const executionTool = v2 ? 'shell' : 'bash';
  const id = randomUUID();
  const root = path.join(settings.directory, 'verification', id);
  const project = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  await mkdir(project, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const pluginDir = path.join(configDir, 'plugins', 'gemini-verify');
  if (v2) {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'index.js'), `export { default } from ${JSON.stringify(pluginURL)};\n`);
  }
  const token = `VERIFY_TEST_OK_${id.replaceAll('-', '')}`;
  const calculator = 'module.exports.add = (a, b) => a - b;\n';
  const check = `const assert = require('node:assert/strict');\nconst { add } = require('./calculator.cjs');\nassert.equal(add(7, 5), 12);\nassert.equal(add(-3, 8), 5);\nassert.equal(add(0, 0), 0);\nconsole.log(${JSON.stringify(token)});\n`;
  await writeFile(path.join(project, 'calculator.cjs'), calculator, { mode: 0o600 });
  await writeFile(path.join(project, 'check.cjs'), check, { mode: 0o600 });
  const config = {
    $schema: 'https://opencode.ai/config.json',
    ...(v2 ? { plugins: [pathToFileURL(pluginDir).href] } : { plugin: [pluginURL] }),
    enabled_providers: [PROVIDER],
    model: `${PROVIDER}/${model}`, small_model: `${PROVIDER}/${model}`,
    permission: { '*': 'deny', read: 'allow', edit: { '*': 'deny', 'calculator.cjs': 'allow' }, bash: { '*': 'deny', 'node check.cjs': 'allow' }, external_directory: 'deny' },
    agent: { 'gemini-verify': {
      mode: 'primary',
      prompt: 'Work only on this temporary verification project. Read calculator.cjs, use edit to fix its add function, then use bash to run exactly node check.cjs. Wait for actual tool results. After the check succeeds, report its verification token. Never modify check.cjs.',
      tools: { '*': false, read: true, edit: true, bash: true },
    } },
  };
  if (v2) {
    delete config.permission;
    delete config.agent;
    config.permissions = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: 'calculator.cjs', effect: 'allow' },
      { action: 'edit', resource: 'calculator.cjs', effect: 'allow' },
      { action: 'shell', resource: 'node check.cjs', effect: 'allow' },
    ];
    config.agents = { 'gemini-verify': { mode: 'primary', steps: 6,
      system: 'Work only on this temporary verification project. Read calculator.cjs, use edit to fix its add function, then use shell to run exactly node check.cjs. Wait for actual tool results. After the check succeeds, report its verification token. Never modify check.cjs.' } };
  }
  await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = { ...process.env,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: path.join(configDir, 'opencode.json'),
    OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    GEMINI_ACCOUNT_DATA_DIR: settings.directory,
  };
  onProgress('正在通过 OpenCode 原生登录流程连接。请在独立窗口完成登录；已有会话会自动确认。');
  const events = [];
  const errors = [];
  let finalText = '';
  let hostError = false;
  let pending = '';
  const acceptLine = line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'error') {
      hostError = true;
      let code;
      try { code = JSON.parse(event.error?.data?.responseBody).error?.code; } catch {}
      code ??= event.error?.message?.match(/^([a-z_]{1,64}):/)?.[1];
      const knownCode = typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
      errors.push({ name: event.error?.name ?? event.error?.type, status: event.error?.data?.statusCode, code: knownCode });
      onProgress(`OpenCode 返回错误${knownCode ? ` (${knownCode})` : ''}；本轮验收失败。`);
    }
    if (event.type === 'text') finalText += event.part?.text ?? '';
    if (event.type !== 'tool_use' || !event.part) return;
    const { tool, state } = event.part;
    events.push({ tool, status: state?.status, exit: state?.metadata?.exit ?? state?.metadata?.metadata?.exit,
      command: tool === executionTool && state?.input?.command === 'node check.cjs' ? 'node check.cjs' : undefined,
      hasCheckToken: typeof state?.output === 'string' && state.output.includes(token) });
    onProgress(`OpenCode 工具 ${tool}: ${state?.status ?? 'unknown'}`);
  };
  const heartbeat = setInterval(() => onProgress('仍在等待网页或工具结果；未自动重发。'), 15000);
  let child;
  let authenticated = false;
  try {
    const login = await runProcess(command.file, [...command.prefix, 'auth', 'login', ...(v2 ? [PROVIDER, '--method', backend, '--standalone'] : ['--provider', PROVIDER, '--method', loginLabel(backend)])], {
      env, cwd: project, timeoutMs: settings.loginTimeoutMs + 60000, signal,
    });
    authenticated = login.code === 0;
    if (!authenticated) {
      hostError = true; errors.push({ code: 'authentication_failed' }); child = login;
      onProgress('原生登录未完成；未发送生成请求。');
    } else {
      onProgress('原生登录完成。正在重新打开持久会话，验证 read → edit → bash。');
      child = await runProcess(command.file, [...command.prefix, 'run', ...(v2 ? ['--standalone'] : ['--dir', project]), '--model', `${PROVIDER}/${model}`, '--agent', 'gemini-verify', '--format', 'json', '--title', 'Gemini Account acceptance', `Read calculator.cjs, fix add so it adds instead of subtracts, then run exactly node check.cjs with ${executionTool}. Do not change check.cjs. Report the verification token only after the test passes.`], {
        env, cwd: project, timeoutMs, signal,
        stdout(chunk) {
          pending += chunk;
          if (pending.length > 2_000_000) throw new Error('OpenCode 单条事件过大');
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            acceptLine(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          }
        },
      });
      if (pending.trim()) acceptLine(pending);
    }
  } catch {
    child = { code: null }; hostError = true;
    errors.push({ code: signal?.aborted ? 'verification_cancelled' : 'host_process_failed' });
    onProgress('验收进程未完成；未自动重发。请确认 OpenCode 路径及独立浏览器状态。');
  } finally { clearInterval(heartbeat); }
  const checkUnchanged = digest(await readFile(path.join(project, 'check.cjs'))) === digest(check);
  const fileChanged = digest(await readFile(path.join(project, 'calculator.cjs'))) !== digest(calculator);
  let independentCheck = false;
  // Never run a checker modified by the model.
  if (checkUnchanged && fileChanged && !signal?.aborted) {
    let output = '';
    const run = await runProcess(process.execPath, ['check.cjs'], { cwd: project, timeoutMs: 10000, stdout: c => { output += c; } });
    independentCheck = run.code === 0 && output.trim() === token;
  }
  const completed = name => events.some(e => e.tool === name && e.status === 'completed');
  const report = {
    version: 1, pluginVersion: '0.5.0', hostVersion: hostVersion.trim(), executionTool, mode: 'native-opencode', backend, model,
    hostExitCode: child.code, hostError,
    checks: {
      authenticated,
      read: completed('read'), edit: completed('edit'),
      bash: events.some(e => e.tool === executionTool && e.status === 'completed' && e.command === 'node check.cjs' && e.exit === 0 && e.hasCheckToken),
      checkerUnchanged: checkUnchanged, fileChanged, independentCheck,
      finalReply: finalText.includes(token),
    },
    tools: events, errors,
  };
  report.passed = child.code === 0 && !hostError && Object.values(report.checks).every(Boolean);
  const reportPath = path.join(root, 'verification.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, reportPath, project };
}

export function runProcess(executable, args, { env = process.env, cwd, timeoutMs = 30000, stdout = () => {}, stderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let failure;
    let hardKill;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      hardKill.unref();
    };
    const timer = setTimeout(() => stop(new Error('验收等待超时；未自动重发，请查看独立浏览器。')), timeoutMs);
    const aborted = () => stop(signal.reason);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { try { stdout(chunk); } catch (e) { stop(e); } });
    // Drain stderr without retaining prompts, account information or tool data.
    if (stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { try { stderr(chunk); } catch (e) { stop(e); } });
    } else child.stderr.resume();
    child.once('error', () => { failure ??= new Error('无法启动 OpenCode。请确认已安装，或用 --opencode 指定原生可执行文件。'); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(hardKill);
      signal?.removeEventListener('abort', aborted);
      if (failure) reject(failure); else resolve({ code });
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('用户取消验收'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help')) {
      console.log('用法：npm run verify -- --backend web|studio [--studio-model ID] [--opencode 原生程序路径]');
      console.log('前提：npm run configure -- --tools on。会在临时项目中由实际 OpenCode 读取、修改文件并运行检查，约使用四轮真实网页生成。');
      console.log('会先通过 OpenCode 原生流程打开独立登录窗口，已有会话自动确认。请先退出其他使用此插件的 OpenCode 实例。');
    } else {
      const options = {};
      for (let i = 0; i < args.length; i++) {
        const key = ({ '--backend': 'backend', '--studio-model': 'upstreamModel', '--opencode': 'executable' })[args[i]];
        if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数无效，请运行 npm run verify -- --help');
        options[key] = args[++i];
      }
      const settings = await loadSettings();
      if (!['web', 'studio'].includes(options.backend)) throw new Error('--backend 必须为 web 或 studio');
      if (!settings.experimentalTools) throw new Error('请先运行 npm run configure -- --tools on，再执行验收。');
      const result = await verifyAgent({ settings, ...options, signal: cancellation.signal });
      console.log(`${result.report.passed ? '验收通过' : '验收失败'}：${result.reportPath}`);
      console.log(`测试项目：${result.project}`);
      if (!result.report.passed) process.exitCode = 1;
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
