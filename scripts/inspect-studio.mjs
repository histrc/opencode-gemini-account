import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const expected082 = {
  'package.json': 'ec6085d4577a1dc06dd0278374d92a4a9469c17388b879b1847ffacd23a84b70',
  'managed.mjs': '49d80347d145312361cd735c0a3fc57b44144dae4a1075902bc12ffce8f640ff',
  'src/managed-backends.mjs': '176f9d53ad68c1e9bab21ddb7f804dfa2ab8c0744e37295da49e7f4f229420f4',
  'src/managed-runtime.mjs': '248763d3b2702b6a9648f117b5a17b15ed81e64722d244190b0b10f7ea1cd6c9',
  'src/studio-chat-mode.mjs': '8dedcf663eeb0f71bc857d5b3e29532afc9a46b7607b6bbed8686bc44afc03df',
  'src/managed-diagnostics.mjs': 'cd27ef5b4cdb3d4a3de417f6e7d7d7583cdb931528b7a6e6fba94e66d9387366',
  'vendor/magpie/lib/studio-native.mjs': '3c741910b522417e98870fd68aee621a6151b82b62cf1d03a298108934ee3c4c',
};
const pick = (value, values) => values.includes(value) ? value : 'unknown';
const number = (value, max = 1e9) => Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const model = value => typeof value === 'string' && /^gemini-[a-zA-Z0-9._-]{1,120}$/.test(value) ? value : 'unknown';

export function safeBackend(value = {}) {
  return { backend: 'studio', status: pick(value.status, ['running', 'stopped', 'not_installed', 'outdated', 'version_conflict', 'foreign', 'unresponsive']),
    state: pick(value.state, ['RUNNING', 'STOPPED', 'LAUNCHING', 'STOPPING', 'ERROR']),
    version: typeof value.version === 'string' && /^v\d+\.\d+\.\d+(?:-magpie\.\d+)?$/.test(value.version) ? value.version : 'unknown',
    chatMode: pick(value.chatMode, ['stream', 'nonstream']),
    accounts: Object.fromEntries(['total', 'ready', 'busy', 'cooldown', 'auth_required'].map(key => [key, number(value.accounts?.[key])])) };
}

export function safeRuntime(value = {}) {
  return { engine: pick(value.waa_backend, ['camoufox', 'spidermonkey', 'go']),
    channels: Array.isArray(value.upstream_channels) ? value.upstream_channels.map(channel => pick(channel, ['playground', 'build'])) : [],
    fakeStream: boolean(value.fake_stream), nonstreamKeepalive: boolean(value.nonstream_keepalive),
    proxyConfigured: typeof value.active_proxy === 'string' && value.active_proxy.length > 0,
    modelMappingConfigured: typeof value.model_mapping === 'string' && value.model_mapping.trim().length > 0,
    modelChannelsConfigured: typeof value.model_channels === 'string' && value.model_channels.trim().length > 0,
    serviceRestartRequired: boolean(value.service_restart_required), managementRestartRequired: boolean(value.management_restart_required) };
}

export function safeAccounts(value) {
  const accounts = Array.isArray(value) ? value : Array.isArray(value?.accounts) ? value.accounts : [];
  return accounts.slice(0, 10).map(account => ({ state: pick(account.state, ['ready', 'busy', 'cooldown', 'auth_required', 'disabled', 'unavailable', 'standby', 'warming']),
    tier: pick(String(account.benefit_tier ?? '').toLowerCase(), ['free', 'plus', 'pro', 'ultra']),
    hasOwnProxy: typeof account.proxy === 'string' && account.proxy.length > 0,
    modelCount: Array.isArray(account.models) ? account.models.length : null,
    listsFlashLite: account.models?.includes('gemini-3.5-flash-lite') === true,
    listsBananaPro: account.models?.includes('gemini-3-pro-image') === true }));
}

export function safeRecord(value = {}) {
  const error = typeof value.error === 'string' ? value.error : '';
  const rpc = /\b(StreamGenerateContent|streamGenerateContent|GenerateContent|CountTokens)\b/.exec(error)?.[1] ?? null;
  const protocol = /协议错误码\s*(\d{1,3})/.exec(error)?.[1];
  const denied = /The caller does not have permission|PERMISSION_DENIED/.test(error);
  const expired = /UNAUTHENTICATED/.test(error);
  return { model: model(value.model), channel: pick(value.channel, ['playground', 'build']),
    http: number(value.status, 599), durationMs: number(value.duration_ms), toolCalls: number(value.tool_calls), rpc,
    protocolCode: protocol === undefined ? null : Number(protocol),
    errorKind: denied ? 'GOOGLE_PERMISSION_DENIED' : expired ? 'AUTHENTICATION_REQUIRED' : error ? 'OTHER_ERROR' : 'NONE',
    attemptCount: Array.isArray(value.attempts) ? value.attempts.length : 0 };
}

export async function inspectAdmin(local, admin) {
  const to = new Date(), from = new Date(to.getTime() - 24 * 3600000);
  const range = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), limit: '8' });
  const targets = [['runtime', '/api/config', safeRuntime], ['accounts', '/api/accounts', safeAccounts],
    ['recent', '/api/usage/records?' + range, value => Array.isArray(value?.items) ? value.items.map(safeRecord) : []]];
  const result = {};
  for (const [name, route, sanitize] of targets) {
    try { result[name] = sanitize(await admin(local, 'GET', route)); }
    catch { result[name] = { available: false }; }
  }
  return result;
}

async function main() {
  const report = { inspection: 'read-only-local-backend', node: process.version, filesMatch082: {}, hostVersion: 'unknown' };
  for (const [file, expected] of Object.entries(expected082)) {
    try { report.filesMatch082[file] = createHash('sha256').update((await readFile(new URL(file, root), 'utf8')).replaceAll('\r\n', '\n')).digest('hex') === expected; }
    catch { report.filesMatch082[file] = false; }
  }
  try {
    const { resolveOpenCode } = await import('../src/opencode-command.mjs');
    const command = await resolveOpenCode();
    const version = spawnSync(command.file, [...command.prefix, '--version'], { encoding: 'utf8', timeout: 8000, maxBuffer: 65536, windowsHide: true });
    report.hostVersion = /\d+\.\d+\.\d+/.exec(String(version.stdout ?? '') + String(version.stderr ?? ''))?.[0] ?? 'unknown';
  } catch {}
  try {
    const [{ loadSettings }, { ManagedBackends }, { studioAdmin }] = await Promise.all([
      import('../src/managed-settings.mjs'), import('../src/managed-backends.mjs'), import('../vendor/magpie/lib/studio-native.mjs'),
    ]);
    const manager = new ManagedBackends(await loadSettings());
    report.backend = safeBackend(await manager.status('studio'));
    if (report.backend.status === 'running') Object.assign(report, await inspectAdmin(manager.existing('studio'), studioAdmin));
  } catch { report.backend = { available: false }; }
  const output = new URL(`studio-inspection-${randomUUID().slice(0, 8)}.txt`, root);
  const text = JSON.stringify(report, null, 2);
  await writeFile(output, text + '\n', { flag: 'wx', mode: 0o600 });
  console.log(text);
  console.log(`\n检查完成：${path.basename(output.pathname)}。此文件已过滤账号、凭据和原始正文；请把它发回排查。`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch { console.error('检查未完成，请确认检查器已解压到 0.8.2 插件根目录且该目录可写。'); process.exitCode = 1; }
}
