import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.mjs';

// This is an explicit, opt-in choice for recognition requests only. Never
// change models after submission or silently fall back to another version.
export async function selectWebVisionMode(page, signal, visibleTarget) {
  const buttons = ['button[aria-label*="打开模式选择器"]', 'button[aria-label*="Open mode picker"]'];
  const button = await visibleTarget(page, buttons);
  const mismatch = () => new BridgeError('未能确认网页识图模式为 3.5 Flash-Lite，本轮没有上传或发送。请检查账号可用模式，或设置 webVisionMode=current 保留网页选择。', 422, 'web_vision_mode_unavailable');
  if (!button) throw mismatch();
  await button.click();
  const deadline = Date.now() + 6000;
  while (true) {
    signal.throwIfAborted();
    const items = page.getByRole('menuitem');
    let chosen;
    for (let i = 0, count = await items.count(); i < count; i++) {
      const item = items.nth(i);
      if (!(await item.isVisible())) continue;
      const text = (await item.innerText()).trim().replace(/^已选中\s*|^Selected\s*/i, '');
      if (!/^3\.5\s+Flash-Lite(?:\s|$)/i.test(text)) continue;
      if (chosen) throw mismatch();
      chosen = item;
    }
    if (chosen) {
      await chosen.click();
      const confirmDeadline = Date.now() + 3000;
      while (true) {
        signal.throwIfAborted();
        const current = await visibleTarget(page, buttons);
        if (current && /(?:当前模式为|current mode (?:is|:))\s*[“"']?Flash-Lite[”"']?(?:\s|,|$)/i.test(await current.getAttribute('aria-label') ?? '')) return;
        if (Date.now() >= confirmDeadline) throw mismatch();
        await delay(100, undefined, { signal });
      }
    }
    if (Date.now() >= deadline) throw mismatch();
    await delay(100, undefined, { signal });
  }
}
