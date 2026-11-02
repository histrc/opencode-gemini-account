import path from 'node:path';
import { createBridge } from './create-bridge.mjs';
import { BridgeError } from './errors.mjs';

// OpenCode initializes plugins once per project. A persistent profile must have
// one owner, even when several plugin instances exist in the same process.
const registry = Symbol.for('opencode-gemini-account.bridge-pool.v1');
const pool = globalThis[registry] ??= new Map();

export function acquireBridge(settings, create = () => createBridge(settings)) {
  let key = path.resolve(settings.directory);
  if (process.platform === 'win32') key = key.toLowerCase();
  const fingerprint = JSON.stringify(settings);
  let entry = pool.get(key);
  if (entry && entry.fingerprint !== fingerprint) {
    throw new BridgeError('同一登录目录的设置已变化。请完全退出并重启 OpenCode，使所有项目使用相同设置。', 409, 'settings_conflict');
  }
  if (!entry) {
    entry = { bridge: create(), fingerprint, users: 0 };
    pool.set(key, entry);
  }
  entry.users++;
  let released = false;
  return {
    bridge: entry.bridge,
    async release() {
      if (released) return;
      released = true;
      if (--entry.users) return;
      // Keep the owner until close completes; a new acquisition must not race
      // another Chromium launch against the profile that is still closing.
      entry.fingerprint = null;
      try { await entry.bridge.dispose(); }
      finally { if (pool.get(key) === entry) pool.delete(key); }
    },
  };
}
