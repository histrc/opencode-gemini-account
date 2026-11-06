import path from 'node:path';
import { readFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({
  enabled: false,
  triggerMessages: 120,
  keepRecentMessages: 80,
  summaryMaxChars: 24000,
  messageExcerptChars: 900,
  toolDescriptionMaxChars: 800,
  schemaDescriptionMaxChars: 240,
});

function integer(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function validateManagedContext(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('managed-context.json 必须是 JSON 对象');
  const allowed = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`managed-context.json 未知设置：${key}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('managed-context.json enabled 必须是布尔值');
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    triggerMessages: integer(raw.triggerMessages, DEFAULTS.triggerMessages, 20, 2000),
    keepRecentMessages: integer(raw.keepRecentMessages, DEFAULTS.keepRecentMessages, 10, 500),
    summaryMaxChars: integer(raw.summaryMaxChars, DEFAULTS.summaryMaxChars, 2000, 100000),
    messageExcerptChars: integer(raw.messageExcerptChars, DEFAULTS.messageExcerptChars, 100, 5000),
    toolDescriptionMaxChars: integer(raw.toolDescriptionMaxChars, DEFAULTS.toolDescriptionMaxChars, 80, 5000),
    schemaDescriptionMaxChars: integer(raw.schemaDescriptionMaxChars, DEFAULTS.schemaDescriptionMaxChars, 40, 2000),
  };
}

export async function managedContextSettings(directory) {
  try { return validateManagedContext(JSON.parse(await readFile(path.join(directory, 'managed-context.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return DEFAULTS; throw new Error(`本机上下文压缩配置无效：${error.message}`); }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

function excerpt(value, limit) {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const head = Math.ceil(limit * 0.7), tail = limit - head;
  return `${normalized.slice(0, head)} …[已压缩 ${normalized.length - limit} 字符]… ${normalized.slice(-tail)}`;
}

function toolNames(message) {
  if (!Array.isArray(message?.tool_calls)) return '';
  return message.tool_calls.map(call => call?.function?.name || call?.name).filter(Boolean).join(', ');
}

function safeRecentStart(messages, wanted) {
  let index = Math.max(0, messages.length - wanted);
  while (index < messages.length && messages[index]?.role !== 'user') index++;
  return index >= messages.length ? -1 : index;
}

function summarize(messages, settings) {
  const lines = [
    '以下是插件对较早对话的本地确定性压缩。它不是模型生成的结论；真实代码、当前文件和最近完整消息优先。',
  ];
  for (const message of messages) {
    if (!message || ['system', 'developer'].includes(message.role)) continue;
    const names = toolNames(message);
    if (names) lines.push(`assistant 调用了工具：${names}`);
    const content = textContent(message.content);
    if (!content) {
      if (message.role === 'tool') lines.push(`工具结果 ${message.name || message.tool_call_id || ''}：已省略旧输出`);
      continue;
    }
    const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '工具';
    lines.push(`${label}：${excerpt(content, settings.messageExcerptChars)}`);
    if (lines.join('\n').length >= settings.summaryMaxChars) break;
  }
  return excerpt(lines.join('\n'), settings.summaryMaxChars);
}

function compactMessages(messages, settings) {
  if (!Array.isArray(messages) || messages.length <= settings.triggerMessages) return messages;
  const recentStart = safeRecentStart(messages, settings.keepRecentMessages);
  if (recentStart <= 0) return messages;
  const instructions = messages.slice(0, recentStart).filter(message => ['system', 'developer'].includes(message?.role));
  const summary = summarize(messages.slice(0, recentStart), settings);
  return [...instructions, { role: 'user', content: summary }, ...messages.slice(recentStart)];
}

function compactDescriptions(value, settings, root = false) {
  if (Array.isArray(value)) return value.map(item => compactDescriptions(item, settings));
  if (!value || typeof value !== 'object') return value;
  const toolFunction = root || (typeof value.name === 'string' && value.parameters && typeof value.parameters === 'object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'description' && typeof item === 'string') {
      result[key] = excerpt(item, toolFunction ? settings.toolDescriptionMaxChars : settings.schemaDescriptionMaxChars);
    } else result[key] = compactDescriptions(item, settings, false);
  }
  return result;
}

export function compactManagedPayload(body, settings) {
  if (!settings.enabled || !body || typeof body !== 'object' || Array.isArray(body)) return { body, changed: false };
  const messages = compactMessages(body.messages, settings);
  const tools = Array.isArray(body.tools) ? body.tools.map(tool => compactDescriptions(tool, settings, true)) : body.tools;
  const changed = messages !== body.messages || (Array.isArray(body.tools) && JSON.stringify(tools) !== JSON.stringify(body.tools));
  return { body: changed ? { ...body, messages, ...(tools ? { tools } : {}) } : body, changed };
}

export async function compactManagedRequest(init, directory) {
  const settings = await managedContextSettings(directory);
  if (!settings.enabled || init?.method !== 'POST' || init.body == null) return init;
  const raw = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
  const { body, changed } = compactManagedPayload(JSON.parse(raw), settings);
  if (!changed) return init;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  return { ...init, headers, body: JSON.stringify(body) };
}

