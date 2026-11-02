import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveOpenCode } from '../src/opencode-command.mjs';
import { loadSettings } from '../src/managed-settings.mjs';
import { runProcess } from './verify.mjs';
import { ManagedBackends, MANAGED_PROVIDERS } from '../src/managed-backends.mjs';

try {
  const argsInput = process.argv.slice(2);
  const legacy = argsInput.includes('--legacy-browser');
  const [action, backend = 'studio'] = argsInput.filter(arg => arg !== '--legacy-browser');
  if (!['connect', 'smoke'].includes(action) || !['studio', 'web'].includes(backend) || argsInput.length > (legacy ? 3 : 2)) throw new Error('用法：node scripts/local.mjs connect|smoke [studio|web] [--legacy-browser]');
  const command = await resolveOpenCode();
  let version = '';
  const accept = c => { version += c; };
  const check = await runProcess(command.file, [...command.prefix, '--version'], { stdout: accept, stderr: accept });
  if (check.code !== 0 || !/(?:^|[^\d])2\.\d+\.\d+/.test(version)) throw new Error('此快捷入口面向 OpenCode 2.x；1.x 请按 README 操作。');
  const settings = await loadSettings();
  const provider = legacy ? 'gemini-account' : MANAGED_PROVIDERS[backend];
  let model = `${provider}/${backend}-current`;
  if (!legacy && action === 'smoke') {
    const catalog = await new ManagedBackends(settings).catalog(backend, { install: true });
    const modelID = catalog['gemini-3.5-flash-lite'] ? 'gemini-3.5-flash-lite' : Object.keys(catalog)[0];
    if (!modelID) throw new Error('尚未发现可用模型，请先完成账号连接');
    model = `${provider}/${modelID}`;
  }
  const cwd = path.join(settings.directory, 'smoke-project');
  await mkdir(cwd, { recursive: true });
  const args = action === 'connect'
    ? ['auth', 'login', provider, '--method', legacy ? backend : 'account', '--standalone']
    : ['run', '--standalone', '--model', model, '--format', 'json', '--title', 'Gemini Account local smoke', 'Reply only OK.'];
  if (action === 'smoke') console.log('发送一条真实网页请求；会使用当前网页额度。');
  let progressTimer;
  let progressBusy = false;
  let previousProgress = '';
  const launchedAt = Date.now();
  if (action === 'connect' && backend === 'studio' && !legacy) {
    console.log('首次准备登录浏览器可能下载约 470 MiB；下载和安装进度会显示在这里及连接页面。');
    progressTimer = setInterval(async () => {
      if (progressBusy) return;
      progressBusy = true;
      try {
        const progress = JSON.parse(await readFile(path.join(settings.directory, 'setup-studio-progress.json'), 'utf8'));
        if (progress.updatedAt < launchedAt) return;
        let detail = progress.error || progress.detail || progress.phase;
        if (progress.phase === 'browser-download') {
          const mib = n => (n / 1048576).toFixed(1);
          detail += progress.total ? ` ${mib(progress.received)} / ${mib(progress.total)} MiB (${Math.min(100, Math.floor(progress.received * 100 / progress.total))}%)` : ` 已下载 ${mib(progress.received || 0)} MiB`;
        }
        if (detail !== previousProgress) { console.log(`[准备进度] ${detail}`); previousProgress = detail; }
      } catch {} finally { progressBusy = false; }
    }, 1000);
  }
  const child = spawn(command.file, [...command.prefix, ...args], { cwd, shell: false, stdio: 'inherit', windowsHide: true });
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); }); }
  finally { clearInterval(progressTimer); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
