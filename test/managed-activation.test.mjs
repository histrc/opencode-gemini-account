import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../managed.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';

test('activation registers both connections without inspecting, starting or refreshing a backend', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-activation-'));
  const previousDirectory = process.env.GEMINI_ACCOUNT_DATA_DIR;
  const previousCatalog = ManagedBackends.prototype.catalog;
  const previousExisting = ManagedBackends.prototype.existing;
  let inspections = 0, refreshes = 0, reloads = 0;
  const providers = [], methods = [];
  process.env.GEMINI_ACCOUNT_DATA_DIR = directory;
  ManagedBackends.prototype.existing = function () { inspections++; return {}; };
  ManagedBackends.prototype.catalog = async function () { refreshes++; throw new Error('No backend work permitted during activation'); };
  let cleanup;
  try {
    cleanup = await plugin.setup({
      provider: { transform: async register => register({ add: value => providers.push(value) }), reload: async () => { reloads++; } },
      integration: { transform: async register => register({ update: (_id, update) => update({}), method: { update: value => methods.push(value) } }) },
      tool: { transform: async register => register({ add: () => {} }) },
    });
    assert.deepEqual(providers.map(provider => provider.info.id), ['aistudio-account', 'gemini-web-account']);
    assert.equal(methods.length, 2);
    assert.equal(inspections, 0);
    assert.equal(refreshes, 0);
    assert.equal(reloads, 0);
  } finally {
    cleanup?.();
    ManagedBackends.prototype.catalog = previousCatalog;
    ManagedBackends.prototype.existing = previousExisting;
    if (previousDirectory === undefined) delete process.env.GEMINI_ACCOUNT_DATA_DIR;
    else process.env.GEMINI_ACCOUNT_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('image inventory uses the host-native image package and exposes the tool without backend work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-image-activation-'));
  const previousDirectory = process.env.GEMINI_ACCOUNT_DATA_DIR;
  const previousCached = ManagedBackends.prototype.cachedCatalog;
  const previousCatalog = ManagedBackends.prototype.catalog;
  const providers = [], tools = [];
  process.env.GEMINI_ACCOUNT_DATA_DIR = directory;
  ManagedBackends.prototype.cachedCatalog = async backend => backend === 'studio' ? {
    'gemini-fixture-image': { name: 'Fixture Image', limit: { context: 100, output: 50 }, capabilities: { input: { image: true }, output: { image: true } } },
    'gemini-fixture-chat': { limit: { context: 100, output: 50 }, capabilities: { toolcall: true } },
  } : {};
  ManagedBackends.prototype.catalog = async () => assert.fail('activation must not refresh the backend');
  let cleanup;
  try {
    cleanup = await plugin.setup({
      provider: { transform: async register => register({ add: value => providers.push(value) }) },
      integration: { transform: async register => register({ update: (_id, update) => update({}), method: { update: () => {} } }) },
      tool: { transform: async register => register({ add: value => tools.push(value) }) },
    });
    const studio = providers.find(provider => provider.info.id === 'aistudio-account');
    const image = studio.models.find(model => model.id === 'gemini-fixture-image');
    assert.equal(image.type, 'image');
    assert.equal(image.package, '@opencode/ai/providers/google/images');
    assert.match(image.settings.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/v1beta$/);
    assert.deepEqual(image.capabilities.output, ['text', 'image']);
    assert.equal(studio.models.find(model => model.id === 'gemini-fixture-chat').type, undefined);
    assert.equal(tools[0].name, 'gemini_generate_image');
    assert.ok(!JSON.stringify(providers).includes('as_'));
  } finally {
    cleanup?.();
    ManagedBackends.prototype.cachedCatalog = previousCached;
    ManagedBackends.prototype.catalog = previousCatalog;
    if (previousDirectory === undefined) delete process.env.GEMINI_ACCOUNT_DATA_DIR;
    else process.env.GEMINI_ACCOUNT_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
