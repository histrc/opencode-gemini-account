import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const marker = '// opencode-gemini-account managed loader v1';
export async function install({ configDir, uninstall = false, v2 = false, dataDir, entry = fileURLToPath(new URL('../index.mjs', import.meta.url)) }) {
  const target = v2 ? path.join(configDir, 'plugins', 'gemini-account', 'index.js') : path.join(configDir, 'plugins', 'gemini-account.js');
  let old;
  try { old = await readFile(target, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== undefined && !old.startsWith(marker + '\n')) throw new Error('目标插件文件已存在且不是本安装器创建的，请自行检查后重命名。');
  if (uninstall) {
    if (old !== undefined) await unlink(target);
    return target;
  }
  await readFile(entry); // Do not install a dangling loader.
  if (dataDir !== undefined) {
    if (path.basename(entry) !== 'managed.mjs') throw new Error('--data-dir 仅用于托管后端入口');
    await writeFile(path.join(path.dirname(entry), '.managed-install.json'), JSON.stringify({ dataDirectory: path.resolve(dataDir) }), { mode: 0o600 });
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${marker}\nexport { default } from ${JSON.stringify(pathToFileURL(path.resolve(entry)).href)};\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return target;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const option = args.indexOf('--config-dir');
    const dataOption = args.indexOf('--data-dir');
    if (option !== -1 && !args[option + 1]) throw new Error('--config-dir 需要路径');
    if (dataOption !== -1 && !args[dataOption + 1]) throw new Error('--data-dir 需要路径');
    const known = new Set(['--uninstall', '--v2', '--managed', '--config-dir', '--data-dir', ...(option === -1 ? [] : [args[option + 1]]), ...(dataOption === -1 ? [] : [args[dataOption + 1]])]);
    if (args.some(a => !known.has(a))) throw new Error('用法：node scripts/install.mjs [--config-dir PATH] [--v2] [--managed] [--data-dir PATH] [--uninstall]');
    const configDir = path.resolve(option !== -1 ? args[option + 1] : process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'opencode'));
    const uninstall = args.includes('--uninstall');
    const managed = args.includes('--managed');
    if (dataOption !== -1 && !managed) throw new Error('--data-dir 需要 --managed');
    const target = await install({ configDir, uninstall, v2: managed || args.includes('--v2'), ...(dataOption !== -1 ? { dataDir: args[dataOption + 1] } : {}), ...(managed ? { entry: fileURLToPath(new URL('../managed.mjs', import.meta.url)) } : {}) });
    console.log(`${uninstall ? '已移除' : '已安装'}：${target}`);
    if (!uninstall) console.log(managed ? '请保留当前目录，重启 OpenCode，在 /connect 选择 AI Studio 账号或 Gemini 网页账号；后端将自动部署。' : '请保留当前源码目录，重启 OpenCode，在 /connect 选择 Gemini Account。');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
