import { mkdir } from 'node:fs/promises';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { saveStudioChatMode } from '../src/studio-chat-mode.mjs';

const [action = 'status', backend = 'studio', mode] = process.argv.slice(2);
if (!['prepare', 'status', 'start', 'chat-mode'].includes(action) || !['studio', 'web', 'all'].includes(backend) || process.argv.length > 5 || (action !== 'chat-mode' && mode !== undefined)) throw new Error('用法：node scripts/managed.mjs prepare|start|status [studio|web|all]；或 chat-mode studio stream|nonstream');
const settings = await loadSettings();
if (action === 'chat-mode') {
  if (backend !== 'studio') throw new Error('对话兼容模式仅适用于 AI Studio');
  await saveStudioChatMode(settings.directory, mode);
  console.log(mode === 'nonstream' ? '已启用 AI Studio 非流式兼容模式；完整回复返回后显示文本并交给 OpenCode 执行原生工具。重启 OpenCode 以加载更新后的代码。' : '已恢复 AI Studio 默认流式模式。');
  process.exit(0);
}
const manager = new ManagedBackends(settings);
for (const target of backend === 'all' ? ['studio', 'web'] : [backend]) {
  if (action !== 'status') {
    console.log(`正在自动准备 ${target} 本机后端（下载、校验、启动），无需安装 Magpie。`);
    await manager.ensure(target, action === 'prepare' && target === 'studio');
    try { await manager.catalog(target); } catch {}
  }
  console.log(JSON.stringify(await manager.status(target)));
}
