import test from 'node:test';
import assert from 'node:assert/strict';
import { safeBackend, safeRuntime, safeAccounts, safeRecord, inspectAdmin } from '../scripts/inspect-studio.mjs';

test('support inspection projects fixed fields and never returns account identifiers or raw errors', () => {
  const secret = 'private@example.invalid Bearer sensitive-cookie';
  const report = { backend: safeBackend({ version: secret, state: secret, accounts: { total: secret }, key: secret }), runtime: safeRuntime({ waa_backend: 'spidermonkey', upstream_channels: ['playground', secret], active_proxy_api_key: secret, admin_password: secret, active_proxy: secret, continuation_prompt: secret }),
    accounts: safeAccounts({ accounts: [{ id: secret, label: secret, state: 'ready', benefit_tier: 'pro', proxy: secret, message: secret, models: ['gemini-3.5-flash-lite'] }] }),
    record: safeRecord({ account: secret, model: 'gemini-3.5-flash-lite', channel: 'playground', status: 403, error: `AI Studio GenerateContent 返回 HTTP 403、协议错误码 7: The caller does not have permission ${secret}`, attempts: [{ account: secret, error: secret }], request: secret, response: secret }) };
  assert.doesNotMatch(JSON.stringify(report), /private|Bearer|sensitive|cookie/);
  assert.equal(report.record.rpc, 'GenerateContent');
  assert.equal(report.record.protocolCode, 7);
  assert.equal(report.accounts[0].listsFlashLite, true);
  assert.equal(report.runtime.engine, 'spidermonkey');
});

test('inspection reads only config, account summary and bounded history, with no generation or refresh calls', async () => {
  const routes = [];
  const result = await inspectAdmin({}, async (_local, method, route) => {
    assert.equal(method, 'GET'); routes.push(route);
    if (route === '/api/config') return { waa_backend: 'spidermonkey' };
    if (route === '/api/accounts') return { accounts: [] };
    assert.match(route, /^\/api\/usage\/records\?from=.*&to=.*&limit=8$/);
    throw new Error('private upstream error');
  });
  assert.equal(routes.length, 3);
  assert.deepEqual(result.recent, { available: false });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
