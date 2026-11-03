import path from 'node:path';
import { readFile, access } from 'node:fs/promises';

// This unreleased backend candidate may initialize an empty directory, but must
// never stop or upgrade an existing stable installation as an incidental test.
export async function assertPreviewDirectory(directory, expectedVersion) {
  let installed;
  try { installed = JSON.parse(await readFile(path.join(directory, 'install-manifest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('预览目录安装信息无效，未修改现有安装'); }
  if (installed?.version === expectedVersion) return;
  const present = async name => { try { await access(path.join(directory, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  if (installed || await present('config.json') || await present('auth')) {
    throw Object.assign(new Error('此开发预览仅允许空的隔离目录，或相同后端版本的预览目录；现有稳定安装未修改。'), { code: 'STUDIO_PREVIEW_EXISTING_INSTALL' });
  }
}
