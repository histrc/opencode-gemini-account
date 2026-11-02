import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { DEFAULT_STUDIO_MODELS, isStudioModelID } from './models.mjs';

export const PROVIDER = 'gemini-account';
export function dataDirectory(env = process.env) {
  if (env.GEMINI_ACCOUNT_DATA_DIR) return path.resolve(env.GEMINI_ACCOUNT_DATA_DIR);
  const base = process.platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'))
    : (env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'));
  return path.join(base, 'opencode-gemini-account');
}

export const SITES = Object.freeze({
  studio: {
    url: 'https://aistudio.google.com/prompts/new_chat',
    input: ['ms-prompt-box textarea', 'textarea[aria-label="Type something"]'],
    submit: ['ms-run-button button', 'button.run-button[aria-label="Run"]'],
    reply: ['ms-chat-turn .model-prompt-container ms-text-chunk', 'ms-chat-turn .chat-turn-container.model ms-text-chunk'],
    stop: ['ms-run-button button:has(.spin)', 'button[aria-label="Stop"]'],
    error: ['.model-error', 'ms-error-message'],
    uploadButton: ['button[aria-label="Insert images, videos, audio, or files"]'],
    uploadAction: ['[role="menuitem"]:has-text("Upload File")', 'button:has-text("Upload File")', '[role="menuitem"]:has-text("上传文件")'],
    uploadBusy: ['ms-prompt-box [role="progressbar"]', '.upload-progress'],
    uploadConsent: ['#copyright-acknowledgement-dialog'],
    outputImages: ['ms-chat-turn .model-prompt-container ms-image-chunk img', 'ms-chat-turn .model-prompt-container img[alt*="Generated"]'],
  },
  web: {
    url: 'https://gemini.google.com/app',
    input: ['rich-textarea [contenteditable="true"]', '.ql-editor[contenteditable="true"]'],
    submit: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]', 'button[aria-label="Send"]'],
    reply: ['model-response .markdown'],
    stop: ['button[aria-label="Stop response"]', 'button[aria-label="停止回答"]', 'button.stop-button'],
    error: ['model-response .error-message', '.response-error'],
    uploadButton: ['button[aria-label="上传和工具"]', 'button[aria-label="Upload and tools"]', 'button[aria-label="Add files"]'],
    uploadAction: ['[role="menuitem"]:has-text("Upload files")', '[role="menuitem"]:has-text("Upload Files")', '[role="menuitem"]:has-text("上传文件")', 'button:has-text("上传文件")'],
    uploadBusy: ['rich-textarea [role="progressbar"]', 'uploader-file-preview [role="progressbar"]', '.upload-progress'],
    uploadPreview: ['uploader-file-preview img[alt="attachment"]'],
    outputImages: ['model-response generated-image img', 'model-response img[alt*="AI-generated"]', 'model-response img[alt*="生成"]'],
  },
});

export function validateSettings(raw = {}, directory = dataDirectory()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings.json 必须是 JSON 对象');
  const allowed = new Set(['connectionMode', 'browser', 'executablePath', 'proxy', 'hostOverrides', 'experimentalTools', 'timeoutMs', 'loginTimeoutMs', 'maxPromptChars', 'selectors', 'studioModels', 'keepLastPage', 'studioSearch', 'webVisionMode']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`未知设置：${key}`);
  const settings = {
    directory, connectionMode: 'browser', browser: 'chrome', experimentalTools: false, timeoutMs: 240000,
    loginTimeoutMs: 600000, maxPromptChars: 120000,
    studioModels: [...DEFAULT_STUDIO_MODELS], keepLastPage: true, studioSearch: 'off', webVisionMode: 'current', ...raw,
  };
  if (!['browser', 'extension'].includes(settings.connectionMode)) throw new Error('connectionMode 仅支持 browser 或 extension');
  if (!['chrome', 'msedge', 'chromium'].includes(settings.browser)) throw new Error('browser 仅支持 chrome、msedge、chromium');
  if (typeof settings.experimentalTools !== 'boolean') throw new Error('experimentalTools 必须是布尔值');
  if (settings.connectionMode === 'extension' && settings.experimentalTools) throw new Error('extension 模式当前只支持纯文本，experimentalTools 必须关闭');
  if (typeof settings.keepLastPage !== 'boolean') throw new Error('keepLastPage 必须是布尔值');
  if (!['off', 'current'].includes(settings.studioSearch)) throw new Error('studioSearch 仅支持 off 或 current');
  if (!['current', 'flash-lite'].includes(settings.webVisionMode)) throw new Error('webVisionMode 仅支持 current 或 flash-lite');
  if (!Array.isArray(settings.studioModels) || settings.studioModels.length > 20 || settings.studioModels.some(id => !isStudioModelID(id)) || new Set(settings.studioModels).size !== settings.studioModels.length) {
    throw new Error('studioModels 必须是最多 20 个不重复的 Gemini 模型 ID，且不能以 -tools-experimental 结尾');
  }
  for (const key of ['timeoutMs', 'loginTimeoutMs', 'maxPromptChars']) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new Error(`${key} 必须是正整数`);
  }
  if (settings.proxy !== undefined) {
    const u = new URL(settings.proxy);
    if (!['http:', 'https:', 'socks5:'].includes(u.protocol) || u.username || u.password || !u.hostname || (u.pathname !== '' && u.pathname !== '/') || u.search || u.hash) {
      throw new Error('proxy 应为不含账号密码的 http(s)://host:port 或 socks5://host:port');
    }
  }
  if (settings.hostOverrides !== undefined) {
    if (!settings.hostOverrides || typeof settings.hostOverrides !== 'object' || Array.isArray(settings.hostOverrides)) throw new Error('hostOverrides 必须是域名到 IPv4 的对象');
    const entries = Object.entries(settings.hostOverrides);
    if (entries.length > 32) throw new Error('hostOverrides 最多支持 32 个域名');
    for (const [hostname, ip] of entries) {
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname) || isIP(ip) !== 4) {
        throw new Error('hostOverrides 仅支持小写完整域名和 IPv4');
      }
    }
    if (settings.proxy) throw new Error('hostOverrides 仅用于浏览器默认网络/TUN，不能与 proxy 同时设置');
    settings.hostOverrides = Object.fromEntries(entries);
  } else settings.hostOverrides = {};
  if (settings.executablePath !== undefined && (typeof settings.executablePath !== 'string' || !path.isAbsolute(settings.executablePath))) throw new Error('executablePath 必须是绝对路径');
  const sites = structuredClone(SITES);
  if (raw.selectors) {
    if (typeof raw.selectors !== 'object' || Array.isArray(raw.selectors)) throw new Error('selectors 必须是对象');
    for (const [backend, selectors] of Object.entries(raw.selectors)) {
      if (!Object.hasOwn(SITES, backend) || !selectors || typeof selectors !== 'object' || Array.isArray(selectors)) throw new Error('未知 selectors 入口');
      for (const [key, values] of Object.entries(selectors)) {
        if (!['input', 'submit', 'reply', 'stop', 'error', 'uploadButton', 'uploadAction', 'uploadBusy', 'uploadPreview', 'uploadConsent', 'outputImages'].includes(key) || !Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`无效选择器：${backend}.${key}`);
        sites[backend][key] = values;
      }
    }
  }
  return { ...settings, sites };
}

export async function loadSettings(directory = dataDirectory()) {
  let raw = {};
  try { raw = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('settings.json 无法读取或不是合法 JSON'); }
  return validateSettings(raw, directory);
}
