import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure } from './configure.mjs';
import { dataDirectory } from '../src/settings.mjs';
import { extensionToken } from '../src/extension-bridge.mjs';

try {
  const directory = dataDirectory();
  const { file } = await configure(directory, { connectionMode: 'extension', experimentalTools: false });
  const token = await extensionToken(directory);
  const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  console.log('Edge 扩展模式已启用。请先完全退出其他 OpenCode 实例。');
  console.log(`1. 在 Edge 打开 edge://extensions，开启“开发人员模式”。`);
  console.log(`2. 选择“加载解压缩的扩展”，目录：${extension}`);
  console.log('3. 点击扩展图标，把下面这行本机配对令牌粘贴进去：');
  console.log(token);
  console.log(`设置文件：${file}`);
  console.log('令牌只用于本机 127.0.0.1 桥接，请勿分享。');
  console.log('双击入口接下来会等待扩展连接，随后通过实际 OpenCode 发送一条 Reply only OK.（使用当前网页额度）。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
