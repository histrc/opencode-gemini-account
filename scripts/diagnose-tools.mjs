import { readFile } from 'node:fs/promises';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { compareToolRequests } from '../src/managed-diagnostics.mjs';

try {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const modelAt = args.indexOf('--model');
  const model = modelAt >= 0 ? args[modelAt + 1] : undefined;
  const expected = [...(live ? ['--live'] : []), ...(modelAt >= 0 ? ['--model', model] : [])];
  if (args.length !== expected.length || args.some(arg => !expected.includes(arg)) || (modelAt >= 0 && (!model || model.startsWith('--')))) throw new Error('用法：node scripts/diagnose-tools.mjs [--live --model gemini-模型ID]');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manager = new ManagedBackends(await loadSettings());
  const catalog = await manager.cachedCatalog('studio');
  console.log(JSON.stringify({ plugin: pkg.version, node: process.version, backend: await manager.status('studio'), chatModels: Object.entries(catalog).filter(([, m]) => !m.capabilities?.output?.image).map(([id, m]) => ({ id, toolcall: m.capabilities?.toolcall === true })) }, null, 2));
  if (!live) console.log('以上未发送生成请求。对照诊断：node scripts/diagnose-tools.mjs --live --model 实际模型ID');
  else {
    if (!model || !catalog[model]) throw new Error('请先连接 AI Studio，再用 --model 指定上面列出的实际模型 ID');
    if (!catalog[model].capabilities?.toolcall) throw new Error('目录未声明此模型支持原生工具，请选择 toolcall 为 true 的对话模型');
    console.log('将发送两条真实短请求，使用模型额度；仅增加一个无副作用的函数声明，不执行工具。多账号后端可能选择不同账号，结果不能作为同账号对照。');
    const report = await compareToolRequests(manager, model, row => console.log(JSON.stringify(row)));
    console.log(JSON.stringify({ conclusion: report.conclusion, model: report.model }));
    console.log('ACCEPTED 仅表示请求被接受，不代表读写文件、命令执行等工具闭环已通过。');
    if (!report.results.every(r => r.result === 'ACCEPTED')) process.exitCode = 1;
  }
} catch { console.error('诊断未完成。请确认已连接账号，并在插件目录运行：node scripts/diagnose-tools.mjs --live --model 实际模型ID。诊断不输出原始日志或凭据。'); process.exitCode = 1; }
