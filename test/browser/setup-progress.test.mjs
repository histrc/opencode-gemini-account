import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { createSetupProgress } from '../../src/setup-progress.mjs';

test('setup page displays downloaded bytes, percentage, extraction and completion', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'progress-page-'));
  const progress = await createSetupProgress(directory);
  const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TEST_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    progress.report({ phase: 'browser-download', detail: '测试下载', received: 50 * 1048576, total: 100 * 1048576 });
    await page.goto(progress.url);
    await page.waitForFunction(() => document.querySelector('#steps').textContent.includes('50%'));
    assert.match(await page.locator('#steps').innerText(), /50\.0 \/ 100\.0 MB/);
    progress.report({ phase: 'browser-extract', detail: '正在解压测试文件' });
    await page.waitForFunction(() => document.querySelector('#steps').textContent.includes('正在解压测试文件'));
    await progress.finish();
    await page.waitForFunction(() => document.querySelector('#end').textContent.includes('账号连接成功'));
    assert.equal(await page.locator('li.done').count(), 4);
  } finally { await browser.close(); progress.close(); await rm(directory, { recursive: true, force: true }); }
});
