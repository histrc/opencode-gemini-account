import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, stat, mkdtemp, rename, rm, unlink, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CAMOUFOX_VERSION, camoufoxState } from '../vendor/magpie/lib/studio-native.mjs';

const execFileAsync = promisify(execFile);
const pending = new Map();
const asset = `camoufox-${CAMOUFOX_VERSION}-win.x86_64.zip`;
const source = `https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}/${asset}`;
const failure = (code, message) => Object.assign(new Error(message), { code });

export async function prepareCamoufox(dataDir, { proxy, onProgress = () => {}, platform = process.platform } = {}) {
  if (platform !== 'win32') return;
  const directory = path.resolve(dataDir);
  if (pending.has(directory)) return pending.get(directory);
  const task = install(directory, proxy, onProgress).finally(() => pending.delete(directory));
  pending.set(directory, task);
  return task;
}

async function install(dataDir, proxy, report) {
  const runtime = path.join(dataDir, 'runtime');
  await mkdir(runtime, { recursive: true });
  const lock = await acquireLock(runtime, report);
  try {
    if (camoufoxState(dataDir).ready) { report({ phase: 'browser-ready', detail: '已安装匹配版本，无需下载' }); return; }
    const archive = path.join(runtime, asset + '.part');
    report({ phase: 'browser-check', detail: '检查已下载文件，完整文件会直接复用' });
    if (!(await archiveComplete(archive))) await download(archive, proxy, report);
    else report({ phase: 'browser-check', detail: '找到完整下载，将直接解压，无需再次联网', received: (await stat(archive)).size, total: (await stat(archive)).size });
    const stage = await mkdtemp(path.join(runtime, '.camoufox-install-'));
    try {
      report({ phase: 'browser-extract', detail: '正在解压并校验压缩包；请稍候' });
      try { await execFileAsync('tar.exe', ['-xf', archive, '-C', stage], { windowsHide: true, maxBuffer: 1024 * 1024 }); }
      catch { throw failure('CAMOUFOX_ARCHIVE_INVALID', 'Camoufox 压缩包不完整或解压失败；下载文件已保留，请重试准备步骤'); }
      const ini = await readFile(path.join(stage, 'application.ini'), 'utf8');
      if (!ini.split(/\r?\n/).some(line => line.trim() === `Version=${CAMOUFOX_VERSION}`) || !(await stat(path.join(stage, 'camoufox.exe'))).isFile()) {
        throw failure('CAMOUFOX_VERSION_MISMATCH', 'Camoufox 压缩包版本不匹配，未覆盖现有安装');
      }
      const target = path.join(runtime, 'camoufox');
      try {
        await stat(target);
        if (camoufoxState(dataDir).ready) { report({ phase: 'browser-ready', detail: '其他连接已完成安装，直接复用' }); return; }
        throw failure('CAMOUFOX_TARGET_EXISTS', 'Camoufox 目录存在但版本不完整；已保留该目录，未覆盖运行中的浏览器');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      report({ phase: 'browser-publish', detail: '正在完成安装；遇到 Windows 临时文件占用会稍后重试' });
      await publishWithRetry(stage, target);
      report({ phase: 'browser-ready', detail: '登录浏览器已准备好，下载包保留以便以后复用' });
    } finally { await removeOwnedStage(runtime, stage); }
  } finally { await lock.close(); await unlink(path.join(runtime, '.camoufox-install.lock')).catch(() => {}); }
}

async function acquireLock(runtime, report) {
  const file = path.join(runtime, '.camoufox-install.lock');
  const deadline = Date.now() + 20 * 60 * 1000;
  while (true) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(file, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('invalid owner');
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { await unlink(file); continue; } }
      } catch {
        try { if (Date.now() - (await stat(file)).mtimeMs > 60000) { await unlink(file); continue; } } catch {}
      }
      if (Date.now() >= deadline) throw failure('CAMOUFOX_INSTALL_BUSY', '其他 OpenCode 正在准备登录浏览器，请等待其结束');
      report({ phase: 'browser-check', detail: '另一个连接正在准备登录浏览器，当前连接等待复用' });
      await delay(1000);
    }
  }
}

async function archiveComplete(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    const { stdout } = await execFileAsync('tar.exe', ['-tf', file], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const names = stdout.split(/\r?\n/).filter(Boolean);
    if (!names.includes('camoufox.exe') || !names.includes('application.ini')) return false;
    for (const name of names) {
      const normalized = name.replaceAll('\\', '/');
      if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) throw failure('CAMOUFOX_ARCHIVE_UNSAFE', 'Camoufox 压缩包包含无效路径，已停止安装');
    }
    return true;
  } catch (error) {
    if (error.code === 'CAMOUFOX_ARCHIVE_UNSAFE') throw error;
    return false;
  }
}

async function download(archive, proxy, report) {
  const headers = archive + '.headers';
  let offset = 0;
  try { offset = (await stat(archive)).size; } catch {}
  report({ phase: 'browser-download', received: offset, total: 0, detail: offset ? '正在续传登录浏览器，网络中断会自动重试' : '首次下载 Windows 登录浏览器，当前版本约 470 MiB' });
  const args = ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--speed-limit', '1', '--speed-time', '60', '--retry', '3', '--retry-delay', '1', '--retry-all-errors', '--continue-at', '-', '--dump-header', headers, '--output', archive];
  if (proxy) args.push('--proxy', proxy);
  args.push(source);
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const received = (await stat(archive)).size;
      const text = await readFile(headers, 'utf8').catch(() => '');
      const range = [...text.matchAll(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/gi)].at(-1);
      const length = [...text.matchAll(/content-length:\s*(\d+)/gi)].at(-1);
      const total = range ? Number(range[1]) : length ? offset + Number(length[1]) : 0;
      report({ phase: 'browser-download', received, total, detail: '正在下载登录浏览器；断线后会继续已有进度' });
    } catch {} finally { polling = false; }
  }, 1000);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(failure('CAMOUFOX_DOWNLOAD_FAILED', '登录浏览器下载中断，已有进度已保留。请确认代理能访问 GitHub，然后重试')));
    });
  } finally { clearInterval(timer); }
  if (!(await archiveComplete(archive))) throw failure('CAMOUFOX_ARCHIVE_INVALID', '下载文件尚不完整，已有文件已保留供下次续传');
}

export async function publishWithRetry(stage, target, { renameFn = rename, sleep = delay, attempts = 12 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await renameFn(stage, target); return; }
    catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= attempts - 1) {
        throw failure('CAMOUFOX_PUBLISH_FAILED', 'Windows 仍在占用登录浏览器文件，暂时无法完成安装。请关闭本插件的登录窗口后重试；无需重新下载');
      }
      await sleep(Math.min(2000, 250 * (attempt + 1)));
    }
  }
}

async function removeOwnedStage(runtime, stage) {
  try {
    const actual = await realpath(stage);
    const parent = await realpath(runtime);
    const relative = path.relative(parent, actual);
    if (relative.startsWith('.camoufox-install-') && !relative.includes(path.sep)) await rm(actual, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
