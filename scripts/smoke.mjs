import { BrowserBridge } from '../src/browser.mjs';
import { loadSettings } from '../src/settings.mjs';

// Explicit user-invoked live check; consumes one real webpage generation.
const [backend, ...words] = process.argv.slice(2);
if (!['studio', 'web'].includes(backend)) {
  console.error('用法：node scripts/smoke.mjs studio|web [提示词]。会登录并发送一条真实网页消息。');
  process.exitCode = 1;
} else {
  let bridge;
  try {
    bridge = new BrowserBridge(await loadSettings());
    console.log('请在独立浏览器窗口完成登录，保留窗口等待自动确认。');
    const page = await bridge.openLogin(backend);
    await bridge.waitLogin(backend, page);
    const prompt = words.join(' ') || '请只回复 OK，不要添加其他内容。';
    console.log(await bridge.generate(backend, prompt, AbortSignal.timeout(240000)));
  } catch (e) {
    // BrowserBridge wraps Playwright action errors before they reach this point.
    console.error(e.code ? `${e.code}: ${e.message}` : '检查未完成，请确认浏览器与设置。');
    process.exitCode = 1;
  } finally { await bridge?.dispose(); }
}
