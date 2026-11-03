import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { resolveOpenCode } from '../src/opencode-command.mjs';
import { runProcess } from './verify.mjs';
import { selectImageModel } from '../src/managed-image-tool.mjs';
import { imageType } from '../src/media.mjs';
import { verificationOptions } from '../src/verification-options.mjs';

const { model: chatModelID, diagnoseRequest } = verificationOptions(process.argv.slice(2));
if (diagnoseRequest) throw new Error('生图验收不支持 --diagnose-request');
const settings = await loadSettings();
const manager = new ManagedBackends(settings);
const catalog = await manager.catalog('studio', { install: true });
if (!catalog[chatModelID]?.capabilities?.toolcall) throw new Error('指定聊天型号未列为支持原生工具调用');
const imageModel = selectImageModel(catalog, process.env.GEMINI_ACCOUNT_IMAGE_MODEL);
const base = path.join(settings.directory, 'managed-image-verification');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'native-'));
const project = path.join(root, 'project'), config = path.join(root, 'config');
await mkdir(project); await mkdir(path.join(config, 'plugins', 'managed-image'), { recursive: true });
await writeFile(path.join(config, 'plugins', 'managed-image', 'index.js'), `export { default } from ${JSON.stringify(new URL('../managed.mjs', import.meta.url).href)};\n`);
const chatModel = 'aistudio-account/' + chatModelID;
await writeFile(path.join(config, 'opencode.json'), JSON.stringify({
  enabled_providers: ['aistudio-account'], model: chatModel, small_model: chatModel,
  permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'gemini_generate_image', resource: '*', effect: 'allow' }],
  agents: { 'image-verify': { mode: 'primary', steps: 3, system: 'Call gemini_generate_image exactly once using the specified model, prompt, aspect and resolution. Do not use other tools and do not retry. Report the saved image path from the actual tool result.' } },
}));
const env = { ...process.env, GEMINI_ACCOUNT_DATA_DIR: settings.directory, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data') };
let pending = '', errors = 0, calls = 0, completed;
const started = Date.now();
function event(line) {
  let value; try { value = JSON.parse(line); } catch { return; }
  if (value.type === 'error') { errors++; console.log('OpenCode 生图请求未完成：' + String(value.error?.message ?? value.error?.data?.message ?? value.error?.type ?? 'unknown').replace(/as_[a-f0-9]+|Bearer\s+\S+/gi, '<redacted>').slice(0, 500)); }
  if (value.type === 'tool_use' && value.part?.tool === 'gemini_generate_image') {
    if (value.part.state?.status === 'error') { errors++; console.log('生图工具错误：' + String(value.part.state.error).slice(0, 500)); }
    if (value.part.state?.status === 'completed') {
      calls++;
      completed = value.part.state.metadata;
      console.log('原生生图工具已完成，正在验证实际图片文件。');
    }
  }
}
const command = await resolveOpenCode();
console.log(`真实 OpenCode 生图验收：聊天型号 ${chatModelID} → gemini_generate_image → 图片型号 ${imageModel}。`);
const run = await runProcess(command.file, [...command.prefix, 'run', '--standalone', '--model', chatModel, '--agent', 'image-verify', '--format', 'json', '--title', 'Managed image verification',
  `Use gemini_generate_image exactly once. model=${imageModel}, aspect=1:1, resolution=1K. Prompt: An original watercolor illustration of a small teal wooden observatory with a copper roof on a floating moss island at dawn. A yellow kite hangs from the railing and three pink clouds cross the sky. Peaceful hand-painted storybook scenery, no text. Report the actual saved file path. Do not retry.`], {
  env, cwd: project, timeoutMs: 240000,
  stdout(chunk) { pending += chunk; let i; while ((i = pending.indexOf('\n')) >= 0) { event(pending.slice(0, i)); pending = pending.slice(i + 1); } },
});
if (pending.trim()) event(pending);
const metadata = completed?.metadata ?? completed;
const image = metadata?.images?.[0];
const attachment = completed?.content?.filter(item => item.type === 'file').length ?? 0;
let bytes = 0, mime;
let filename;
if (image?.path) { const data = await readFile(image.path); bytes = data.length; mime = imageType(data); filename = 'generated.' + (mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]); await copyFile(image.path, path.join(root, filename)); }
const report = { date: '2026-11-02', host: 'OpenCode 2.2.5 real native tool and image protocol', imageModel, elapsedMs: Date.now() - started,
  exit: run.code, errors, completedCalls: calls, attachments: attachment, image: image ? { filename, bytes, mime, sha256: image.sha256 } : null,
  passed: run.code === 0 && errors === 0 && calls === 1 && attachment === 1 && bytes > 0 };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); console.log('验收目录：' + root);
if (!report.passed) process.exitCode = 1;
