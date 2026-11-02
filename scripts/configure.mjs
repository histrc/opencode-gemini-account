import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory, validateSettings } from '../src/settings.mjs';
import { modelCatalog } from '../src/models.mjs';

export async function configure(directory, patch) {
  const file = path.join(directory, 'settings.json');
  let raw = {};
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('原 settings.json 无法读取或不是合法 JSON；未覆盖原文件'); }
  validateSettings(raw, directory);
  const next = { ...raw, ...patch };
  const settings = validateSettings(next, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
  return { file, settings };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help')) {
      console.log('用法：npm run configure -- [--connection-mode browser|extension] [--browser chrome|msedge|chromium] [--tools on|off] [--keep-page on|off] [--studio-search off|current] [--web-vision-mode current|flash-lite] [--studio-model MODEL_ID] [--timeout-seconds N]');
      console.log('--studio-model 添加一个已知型号；仍须在 OpenCode /models 中选择。修改后重启 OpenCode。');
    } else {
      const patch = {};
      let model;
      for (let i = 0; i < args.length; i += 2) {
        const option = args[i], value = args[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`缺少 ${option} 的值`);
        if (option === '--connection-mode') patch.connectionMode = value;
        else if (option === '--browser') patch.browser = value;
        else if (option === '--studio-search') patch.studioSearch = value;
        else if (option === '--web-vision-mode') patch.webVisionMode = value;
        else if (option === '--tools' || option === '--keep-page') {
          if (!['on', 'off'].includes(value)) throw new Error(`${option} 仅支持 on / off`);
          patch[option === '--tools' ? 'experimentalTools' : 'keepLastPage'] = value === 'on';
        } else if (option === '--studio-model') model = value;
        else if (option === '--timeout-seconds') {
          if (!/^\d+$/.test(value)) throw new Error('超时秒数必须为正整数');
          patch.timeoutMs = Number(value) * 1000;
        } else throw new Error(`未知选项：${option}`);
      }
      const directory = dataDirectory();
      if (model) {
        let raw = {};
        try { raw = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw new Error('原 settings.json 不是合法 JSON；未覆盖原文件'); }
        patch.studioModels = [...new Set([...validateSettings(raw, directory).studioModels, model])];
      }
      const result = await configure(directory, patch);
      console.log(`已保存：${result.file}\n请重启 OpenCode。已注册的模型入口：`);
      for (const id of Object.keys(modelCatalog(result.settings))) console.log(`  gemini-account/${id}`);
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
