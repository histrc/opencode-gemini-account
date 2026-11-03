import { connect } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateProxyURL } from '../vendor/magpie/lib/setup.mjs';
import { stopStudio, studioAdmin } from '../vendor/magpie/lib/studio-native.mjs';
import { managedStudioProxy } from '../src/studio-network.mjs';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';

export async function probeProxy(proxy) {
  const url = new URL(proxy);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol.startsWith('socks') ? 1080 : 80));
  await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port });
    let finished = false;
    const finish = success => {
      if (finished) return;
      finished = true; socket.destroy();
      if (success) resolve(); else reject(new Error('网络代理端口未连通，请先启动代理软件'));
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function applyStudioProxy(manager, address, { probe = probeProxy, stop = stopStudio, admin = studioAdmin, resolveProxy = managedStudioProxy, onStage = () => {} } = {}) {
  const proxy = validateProxyURL(address);
  if (!proxy) throw new Error('需要明确的代理地址');
  const parsed = new URL(proxy);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('代理地址应不含凭据、路径、查询参数或片段');
  const file = path.join(manager.settings.directory, 'managed-network.json');
  let network = {};
  try { network = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('现有网络配置无效，未修改'); }
  if (!network || typeof network !== 'object' || Array.isArray(network)) throw new Error('现有网络配置无效，未修改');
  onStage('检查代理端口');
  await probe(proxy);
  onStage('检查后端状态');
  const status = await manager.status('studio');
  if (!['running', 'stopped'].includes(status.status)) throw new Error('未确认插件拥有的后端状态，未修改');
  if ((status.accounts?.busy ?? 0) > 0) throw new Error('后端正在执行请求，请等待当前请求结束后再操作');
  // The native helper verifies the PID, executable path and listener before
  // stopping this installation. Merely saving a proxy cannot update a live
  // process whose PROXY environment was fixed when it started.
  onStage('停止插件后端');
  const stopped = await stop({ dataDir: manager.directories.studio });
  if (stopped?.stopped !== true) throw new Error('未确认后端已停止，网络设置未修改');
  onStage('保存网络配置');
  await mkdir(manager.settings.directory, { recursive: true });
  await writeFile(file, JSON.stringify({ ...network, proxy }) + '\n', { mode: 0o600 });
  onStage('启动本机管理服务');
  const local = await manager.ensure('studio', true);
  onStage('核对运行中的代理');
  const expected = await resolveProxy(manager.settings.directory, manager.directories.studio, proxy);
  const runtime = await admin(local, 'GET', '/api/config');
  let matches = false;
  try { matches = new URL(runtime.active_proxy).href === new URL(expected).href; } catch {}
  if (!matches) throw new Error('已保存代理，但未确认运行后端使用了该地址，请提供检查报告');
  const backend = await manager.status('studio');
  return { proxyApplied: true, generationReady: backend.state === 'RUNNING' && (backend.accounts?.ready ?? 0) > 0, backend };
}

let operationStage = '检查参数';
async function main() {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/apply-studio-proxy.mjs http://127.0.0.1:7897');
  console.log('正在检查代理端口，并重启插件自身的 AI Studio 后端以应用代理。账号与对话模式会保留。');
  const manager = new ManagedBackends(await loadSettings());
  const result = await applyStudioProxy(manager, process.argv[2], { onStage: stage => { operationStage = stage; console.log(`当前阶段：${stage}`); } });
  console.log(JSON.stringify(result));
  console.log('已核对后端 active_proxy 与配置地址一致；是否解决 Google 403 仍以实际调用为准。');
  if (!result.generationReady) console.log('代理已应用；生成服务仍在准备，请等待就绪后再运行模型验收。');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    const allowed = ['网络代理端口未连通，请先启动代理软件', '需要明确的代理地址', '代理地址应不含凭据、路径、查询参数或片段', '现有网络配置无效，未修改', '未确认插件拥有的后端状态，未修改', '后端正在执行请求，请等待当前请求结束后再操作', '未确认后端已停止，网络设置未修改', '已保存代理，但未确认运行后端使用了该地址，请提供检查报告'];
    console.error(allowed.includes(error?.message) ? error.message : `代理应用在“${operationStage}”阶段未完成，请提供检查报告；未输出原始错误或凭据。`);
    process.exitCode = 1;
  }
}
