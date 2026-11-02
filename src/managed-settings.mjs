import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSettings as loadDefaultSettings } from './settings.mjs';

// An installation can pin one shared data directory for desktop and CLI hosts.
// The optional locator contains a path only, never account or service secrets.
export async function loadSettings({ installationURL = new URL('../.managed-install.json', import.meta.url) } = {}) {
  if (process.env.GEMINI_ACCOUNT_DATA_DIR) return loadDefaultSettings();
  let installation;
  try { installation = JSON.parse(await readFile(installationURL, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return loadDefaultSettings(); throw error; }
  if (typeof installation.dataDirectory !== 'string' || !path.isAbsolute(installation.dataDirectory)) throw new Error('插件数据目录必须是绝对路径');
  return loadDefaultSettings(installation.dataDirectory);
}
