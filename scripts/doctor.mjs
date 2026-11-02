import { access } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadSettings } from '../src/settings.mjs';
import { modelCatalog } from '../src/models.mjs';
import { hostResolverArgs } from '../src/browser.mjs';

try {
  const settings = await loadSettings();
  console.log(`Node: ${process.versions.node}`);
  console.log(`设置和会话目录: ${settings.directory}`);
  console.log(`连接方式: ${settings.connectionMode === 'extension' ? '正常 Edge 扩展（AI Studio 纯文本）' : '独立自动化浏览器'}`);
  console.log(`浏览器: ${settings.browser}${settings.executablePath ? '（自定义路径）' : ''}`);
  console.log(`插件代理: ${settings.proxy ? '已配置' : '未配置（使用浏览器默认网络）'}`);
  console.log(`插件域名覆盖: ${Object.keys(settings.hostOverrides).length ? `${Object.keys(settings.hostOverrides).length} 项（仅此独立浏览器）` : '未配置'}`);
  console.log(`工具模拟: ${settings.experimentalTools ? '启用' : '关闭'}`);
  console.log(`Studio 搜索: ${settings.studioSearch === 'off' ? '发送前关闭并核对' : '使用网页现有设置'}`);
  console.log(`Web 识图模式: ${settings.webVisionMode === 'flash-lite' ? '发送前选择并核对 3.5 Flash-Lite' : '使用网页现有模式'}`);
  console.log(`最后一页: ${settings.keepLastPage ? '每个入口保留一页' : '生成后关闭'}`);
  for (const backend of settings.connectionMode === 'extension' ? [] : ['studio', 'web']) {
    let exists = true;
    try { await access(path.join(settings.directory, 'profiles', backend)); } catch { exists = false; }
    console.log(`${backend} 浏览器配置目录: ${exists ? '存在（不代表登录有效）' : '尚未创建'}`);
  }
  console.log('模型入口:');
  for (const [id, model] of Object.entries(modelCatalog(settings))) console.log(`  gemini-account/${id}${model.upstreamModel ? ' → ' + model.upstreamModel : ''}`);
  if (settings.connectionMode === 'extension') {
    console.log('扩展模式沿用正常 Edge 的网络；browser、proxy、hostOverrides 和搜索开关设置只作用于旧独立浏览器。');
    console.log('当前阶段：AI Studio 纯文本。请使用 setup-extension.cmd 完成安装、连接和真实调用验证。');
    if (process.argv.includes('--launch')) throw new Error('扩展模式不启动自动化浏览器');
  }
  if (settings.connectionMode === 'browser' && settings.executablePath) await access(settings.executablePath);
  if (settings.connectionMode === 'browser' && settings.browser === 'chromium' && !settings.executablePath) await access(chromium.executablePath());
  if (process.argv.includes('--launch')) {
    const browser = await chromium.launch({
      headless: true,
      ...(settings.browser === 'chromium' ? {} : { channel: settings.browser }),
      ...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
      ...(Object.keys(settings.hostOverrides).length ? { args: hostResolverArgs(settings.hostOverrides) } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<title>Local browser check</title>');
      if (await page.title() !== 'Local browser check') throw new Error('本地页面检查失败');
      console.log('浏览器启动与本地页面检查通过（没有访问 Google）。');
    } finally { await browser.close(); }
  } else console.log('设置校验通过。可加 --launch 检查浏览器启动。登录和网页调用需另行实测。');
} catch {
  console.error('检查未通过。请检查 settings.json、浏览器安装和 executablePath；Chromium 可运行 npm run browser:install 安装。');
  process.exitCode = 1;
}
