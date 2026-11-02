import { access } from 'node:fs/promises';
import path from 'node:path';

const exists = async file => { try { await access(file); return true; } catch { return false; } };

// npm installs opencode.cmd on Windows. Start the adjacent Node launcher
// directly rather than sending paths or model text through cmd.exe quoting.
export async function resolveOpenCode(executable = 'opencode', { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { file: executable, prefix: [] };
  const explicit = path.isAbsolute(executable) || /[/\\]/.test(executable);
  const directories = explicit ? [path.dirname(path.resolve(executable))] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const basename = explicit ? path.basename(executable) : executable;
  for (const directory of directories) {
    const native = path.join(directory, /\.exe$/i.test(basename) ? basename : `${basename.replace(/\.(cmd|bat)$/i, '')}.exe`);
    if (await exists(native)) return { file: native, prefix: [] };
    const shim = path.join(directory, /\.(cmd|bat)$/i.test(basename) ? basename : `${basename}.cmd`);
    if (!(await exists(shim))) continue;
    for (const launcher of [path.join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode'), path.join(directory, '..', 'opencode-ai', 'bin', 'opencode')]) {
      if (await exists(launcher)) return { file: process.execPath, prefix: [launcher] };
    }
    throw new Error('找到 OpenCode 的命令脚本，但没有找到 npm Node 启动器。请用 --opencode 指定 opencode.exe。');
  }
  // Desktop installs keep the CLI beside app.asar and need not add it to PATH.
  if (!explicit && executable === 'opencode' && env.LOCALAPPDATA) {
    const desktopCLI = path.join(env.LOCALAPPDATA, 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe');
    if (await exists(desktopCLI)) return { file: desktopCLI, prefix: [] };
  }
  throw new Error('未找到 OpenCode。请安装 OpenCode 或用 --opencode 指定 opencode.exe。');
}
