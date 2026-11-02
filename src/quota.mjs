import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.mjs';

const usageName = /^(Usage limits|Usage Limits|使用限额|用量限制|使用限制|用量限额)$/i;
const clean = text => String(text ?? '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[account]').replace(/https?:\/\/\S+/gi, '[link]').slice(0, 12000);
const unitOf = text => /%|percent|百分/i.test(text) ? 'percent' : /image|图片|图像/i.test(text) ? 'images' : /token/i.test(text) ? 'tokens' : /张|枚/.test(text) ? 'images' : 'requests';

export function parseQuotaPanel(text, meters = [], sections = []) {
  const body = clean(text), remaining = [], observedMeters = [];
  const number = '(\\d+(?:\\.\\d+)?)';
  const unit = '(%|percent|prompts?|messages?|requests?|images?|tokens?|次|条|张|枚)';
  const patterns = [
    new RegExp(`(?:remaining|left|剩余|还可用)\\s*[:：]?\\s*${number}\\s*${unit}`, 'gi'),
    new RegExp(`${number}\\s*${unit}\\s*(?:remaining|left|剩余)`, 'gi'),
  ];
  for (const pattern of patterns) for (const m of body.matchAll(pattern)) {
    const value = Number(m[1]), unit = unitOf(m[2]);
    if (Number.isFinite(value) && (unit !== 'percent' || value <= 100)) remaining.push({ value, unit, basis: 'explicit-page-text', evidence: m[0] });
  }
  const usedPatterns = [/(\d+(?:\.\d+)?)\s*%\s*(?:used|consumed|已使用)/gi, /(?:used|consumed|已使用|已用)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/gi];
  for (const pattern of usedPatterns) for (const m of body.matchAll(pattern)) {
    const used = Number(m[1]);
    if (used <= 100) remaining.push({ value: Number((100 - used).toFixed(3)), unit: 'percent', basis: 'derived-from-displayed-used-percent', evidence: m[0] });
  }
  for (const meter of meters) {
    const label = clean(meter.label).slice(0, 250);
    const value = meter.value === null || meter.value === undefined || meter.value === '' ? null : Number(meter.value);
    const min = Number(meter.min ?? 0), max = Number(meter.max ?? 100);
    let meaning = 'unspecified';
    if (/remaining|left|剩余/i.test(label)) meaning = 'remaining';
    else if (/used|consumed|已用|已使用/i.test(label)) meaning = 'used';
    const normalized = { label, value: Number.isFinite(value) ? value : null, min, max, meaning };
    observedMeters.push(normalized);
    if (value !== null && Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min && value >= min && value <= max && meaning !== 'unspecified') {
      const fraction = (value - min) / (max - min);
      remaining.push({ value: Number(((meaning === 'used' ? 1 - fraction : fraction) * 100).toFixed(3)), unit: 'percent', basis: 'derived-from-labelled-page-meter', label });
    }
  }
  const cycles = sections.filter(s => String(s).trim()).map(section => {
    const safe = clean(section);
    const label = safe.match(/^(当前用量|每周限额|Current usage|Weekly limit)/i)?.[0] ?? safe.split('\n')[0].slice(0, 100);
    return { label, ...parseQuotaPanel(safe) };
  });
  const distinct = cycles.length ? cycles.flatMap(cycle => cycle.buckets.map(item => ({ ...item, label: cycle.label }))) : remaining;
  const unique = [...new Map(distinct.map(item => [JSON.stringify(item), item])).values()];
  return {
    status: unique.length ? 'reported' : /(?:reached|exceeded).{0,25}limit|达到.{0,12}上限|额度已用尽/i.test(body) ? 'limited' : 'not_reported',
    remaining: unique.length === 1 ? unique[0] : null,
    buckets: unique, meters: observedMeters, cycles,
    notices: body.split(/\n+/).map(s => s.trim()).filter(s => /reset|refresh|usage|quota|limit|remaining|用量|剩余|重置|刷新|限额|配额|已用|%/i.test(s)).map(s => s.slice(0, 400)).slice(0, 20),
  };
}

function unknown(backend, reason) {
  return { backend, source: backend === 'web' ? 'gemini-web-settings-usage' : 'aistudio-web', checkedAt: new Date().toISOString(), status: 'not_reported', remaining: null, buckets: [], meters: [], notices: [], reason };
}

async function uniqueVisible(locator) {
  let found;
  for (let i = 0, count = await locator.count(); i < count; i++) {
    if (!(await locator.nth(i).isVisible())) continue;
    if (found) return null;
    found = locator.nth(i);
  }
  return found;
}

export async function readQuotaPage(page, backend, site, signal, signedIn) {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const loginDeadline = Date.now() + 15000;
  while (!(await signedIn())) {
    signal.throwIfAborted();
    if (new URL(page.url()).hostname === 'accounts.google.com' || Date.now() >= loginDeadline) throw new BridgeError('请先在 /connect 登录对应的网页入口', 401, 'login_required');
    await delay(150, undefined, { signal });
  }
  if (backend === 'studio') return unknown(backend, '当前未建立可靠的 AI Studio 网页账号剩余额度来源；不会把 Gemini API 项目限额当作网页账号余额。');
  const settings = await uniqueVisible(page.getByRole('button', { name: /^(Settings|Settings & help|设置|设置和帮助)$/i }));
  if (!settings) return unknown(backend, '未找到设置入口，未查询到剩余额度。');
  await settings.click();
  const deadline = Date.now() + 8000;
  let action;
  while (!action) {
    signal.throwIfAborted();
    for (const role of ['menuitem', 'button', 'link']) {
      action = await uniqueVisible(page.getByRole(role, { name: usageName }));
      if (action) break;
    }
    if (!action && Date.now() >= deadline) return unknown(backend, '当前账号的设置菜单没有可读取的使用限额入口。');
    if (!action) await delay(150, undefined, { signal });
  }
  await action.click();
  const panelDeadline = Date.now() + 8000;
  while (true) {
    signal.throwIfAborted();
    if (new URL(page.url()).origin !== new URL(site.url).origin) return unknown(backend, '使用限额页面离开了 Gemini 网站，未读取其他账号或账单页面。');
    const dialogs = page.getByRole('dialog');
    let panel;
    for (let i = 0, count = await dialogs.count(); i < count; i++) {
      const candidate = dialogs.nth(i);
      if (await candidate.isVisible() && /usage limits|使用限额|用量限制|使用限制|用量限额/i.test(await candidate.innerText())) {
        if (panel) return unknown(backend, '发现多个用量面板，无法确认正确来源。');
        panel = candidate;
      }
    }
    let isCycleList = false;
    if (!panel && /usage|limit/i.test(new URL(page.url()).pathname)) {
      const heading = await uniqueVisible(page.getByRole('heading', { name: usageName }));
      const list = await uniqueVisible(page.getByRole('list', { name: /^(Usage periods|Usage cycles|Usage cycle|用量周期)$/i }));
      if (heading && list) { panel = list; isCycleList = true; }
    }
    if (panel) {
      const text = await panel.innerText();
      const meters = await panel.locator('[role="progressbar"], meter, progress').evaluateAll(nodes => nodes
        .filter(n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0)
        .map(n => ({
          label: n.getAttribute('aria-label') || (n.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || n.parentElement?.textContent || '',
          value: n.getAttribute('aria-valuenow') ?? n.getAttribute('value'), min: n.getAttribute('aria-valuemin') ?? n.getAttribute('min') ?? 0, max: n.getAttribute('aria-valuemax') ?? n.getAttribute('max') ?? 100,
        })));
      const sections = isCycleList ? await panel.locator(':scope > *').allTextContents() : [];
      const parsed = parseQuotaPanel(text, meters, sections);
      return { ...unknown(backend, parsed.status === 'reported' ? '按网页周期分别报告；百分比由明确显示的已用百分比换算，不代表固定剩余次数。' : '仅报告网页明确显示的数据；未显示的剩余额度为未知。'), ...parsed };
    }
    if (Date.now() >= panelDeadline) return unknown(backend, '没有确认到独立的使用限额面板，未从聊天回复推断额度。');
    await delay(150, undefined, { signal });
  }
}
