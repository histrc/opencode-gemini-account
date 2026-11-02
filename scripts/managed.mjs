import { mkdir } from 'node:fs/promises';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';

const [action = 'status', backend = 'studio'] = process.argv.slice(2);
if (!['prepare', 'status', 'start'].includes(action) || !['studio', 'web', 'all'].includes(backend)) throw new Error('用法：node scripts/managed.mjs prepare|start|status [studio|web|all]');
const settings = await loadSettings();
const manager = new ManagedBackends(settings);
for (const target of backend === 'all' ? ['studio', 'web'] : [backend]) {
  if (action !== 'status') {
    console.log(`正在自动准备 ${target} 本机后端（下载、校验、启动），无需安装 Magpie。`);
    await manager.ensure(target, action === 'prepare' && target === 'studio');
    try { await manager.catalog(target); } catch {}
  }
  console.log(JSON.stringify(await manager.status(target)));
}
