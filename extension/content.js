const operations = new Map();
const selectors = {
  input: ['ms-prompt-box textarea', 'textarea[aria-label="Type something"]'],
  submit: ['ms-run-button button', 'button.run-button[aria-label="Run"]'],
  reply: ['ms-chat-turn .model-prompt-container ms-text-chunk', 'ms-chat-turn .chat-turn-container.model ms-text-chunk'],
  stop: ['ms-run-button button:has(.spin)', 'button[aria-label="Stop"]'],
  error: ['.model-error', 'ms-error-message'],
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'cancel' && typeof message.id === 'string') {
    if (operations.has(message.id)) {
      operations.get(message.id).abort();
      void clickStop();
    }
    return false;
  }
  if (message?.source !== 'opencode-gemini-account' || typeof message.id !== 'string') return false;
  if (message.action === 'generate' && operations.size) { sendResponse({ ok: false, code: 'busy' }); return false; }
  const controller = new AbortController();
  operations.set(message.id, controller);
  run(message.action, message.payload, controller.signal)
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, code: error?.code ?? 'page_error' }))
    .finally(() => operations.delete(message.id));
  return true;
});

async function run(action, payload, signal) {
  if (location.hostname !== 'aistudio.google.com') throw failure('page_not_ready');
  if (action === 'status') return { ready: Boolean(findVisible(selectors.input)) };
  if (action !== 'generate' || typeof payload?.prompt !== 'string') throw failure('page_error');
  if (payload.prompt.length > 500000 || !location.pathname.startsWith('/prompts/')) throw failure('page_not_ready');
  const input = findVisible(selectors.input);
  if (!input) throw failure('page_not_ready');
  if (findVisible(selectors.error)) throw failure('page_error');
  // Refuse existing chats and unsent user input. Each job gets a fresh tab.
  if (readReplies().length || input.value.trim()) throw failure('page_not_ready');
  const before = readReplies();
  setInput(input, payload.prompt);
  const submit = await waitFor(() => {
    const button = findVisible(selectors.submit);
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }, 10000, signal, 'selector_changed');
  submit.click();

  let last = '';
  let stable = 0;
  let sawBusy = false;
  const deadline = Date.now() + Math.min(900000, Math.max(1000, Number(payload.timeoutMs) || 240000));
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (findVisible(selectors.error)) throw failure('page_error');
    const replies = readReplies();
    const text = replies.at(-1) ?? '';
    const changed = replies.length > before.length || text !== (before.at(-1) ?? '');
    const run = findVisible(selectors.submit);
    const busy = Boolean(findVisible(selectors.stop)) || Boolean(run && (run.disabled || run.getAttribute('aria-disabled') === 'true'));
    if (busy) sawBusy = true;
    if (sawBusy && changed && text && !busy && text === last) stable++; else stable = 0;
    if (stable >= 3) return { text };
    last = text;
    await sleep(200, signal);
  }
  throw failure('generation_unconfirmed');
}

function roots() {
  const found = [document];
  for (let i = 0; i < found.length; i++) {
    for (const element of found[i].querySelectorAll('*')) if (element.shadowRoot) found.push(element.shadowRoot);
  }
  return found;
}

function queryAll(selector) {
  return roots().flatMap(root => [...root.querySelectorAll(selector)]);
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

function findVisible(list) {
  for (const selector of list) {
    const matches = queryAll(selector).filter(visible);
    if (matches.length > 1) throw failure('selector_changed');
    if (matches[0]) return matches[0];
  }
  return null;
}

function setInput(input, value) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw failure('selector_changed');
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function readReplies() {
  for (const selector of selectors.reply) {
    const grouped = new Map();
    for (const node of queryAll(selector).filter(visible)) {
      if (node.closest('ms-thought-chunk, .thought-panel, .thinking-container')) continue;
      const copy = node.cloneNode(true);
      copy.querySelectorAll('button, svg, script, style, mat-icon, ms-thought-chunk, .thought-panel').forEach(el => el.remove());
      copy.querySelectorAll('pre').forEach(pre => {
        const code = pre.querySelector('code');
        const text = code?.textContent ?? pre.textContent;
        const language = code?.className.match(/language-([\w+-]+)/)?.[1] ?? '';
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
        pre.replaceWith(document.createTextNode(`\n${fence}${language}\n${text}\n${fence}\n`));
      });
      copy.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
      copy.querySelectorAll('p, div, li').forEach(el => el.appendChild(document.createTextNode('\n')));
      const text = copy.textContent.trim();
      if (text) {
        const turn = node.closest('ms-chat-turn') ?? node;
        grouped.set(turn, [...(grouped.get(turn) ?? []), text]);
      }
    }
    const values = [...grouped.values()].map(parts => parts.join('\n\n'));
    if (values.length) return values;
  }
  return [];
}

async function waitFor(check, timeout, signal, code) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = check();
    if (value) return value;
    await sleep(100, signal);
  }
  throw failure(code);
}

async function clickStop() {
  try { findVisible(selectors.stop)?.click(); } catch {}
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(failure('cancelled')); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function failure(code) { return Object.assign(new Error(code), { code }); }
