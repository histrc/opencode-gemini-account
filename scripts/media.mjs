import { loadSettings } from '../src/settings.mjs';
import { BrowserBridge } from '../src/browser.mjs';
import { readImageFile, validateImages } from '../src/media.mjs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
let bridge;
try {
  if (!['usage', 'image'].includes(command) || args.includes('--help')) {
    console.log('用法：npm run usage -- [--backend web|studio] [--login]');
    console.log('或：npm run image -- --prompt "提示词" [--backend web|studio] [--model Studio型号ID] [--input 本地图片路径] [--login]');
    console.log('生图会消耗真实网页用量；usage 不发送生成请求。网页未公布的剩余额度为 null。');
  } else {
    const options = { backend: 'web', input: [] };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--login') { options.login = true; continue; }
      const key = ({ '--backend': 'backend', '--prompt': 'prompt', '--model': 'model', '--input': 'input' })[args[i]];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数无效，请加 --help 查看用法');
      const value = args[++i];
      if (key === 'input') options.input.push(value); else options[key] = value;
    }
    if (!['web', 'studio'].includes(options.backend)) throw new Error('--backend 必须是 web 或 studio');
    if (command === 'image' && (!options.prompt || (options.backend === 'studio' && !options.model))) throw new Error('生图需要 --prompt；Studio 还需要已配置的 --model');
    const settings = await loadSettings(); bridge = new BrowserBridge(settings);
    if (options.login) { const page = await bridge.openLogin(options.backend); console.log('请在独立窗口完成登录。'); await bridge.waitLogin(options.backend, page); }
    if (command === 'usage') console.log(JSON.stringify(await bridge.inspectQuota(options.backend), null, 2));
    else {
      const images = [];
      for (const [index, file] of options.input.entries()) images.push(await readImageFile(path.resolve(file), index + 1));
      validateImages(images);
      const result = await bridge.generateImage(options.backend, options.prompt, undefined, { upstreamModel: options.model, images });
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (e) { console.error(e.code ? `${e.code}: ${e.message}` : '操作未完成，请检查参数、浏览器和设置。'); process.exitCode = 1; }
finally { await bridge?.dispose(); }
