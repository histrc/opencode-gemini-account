const ENDPOINT = 'ws://127.0.0.1:37654/';
const STUDIO = 'https://aistudio.google.com/prompts/new_chat';
let socket;
let retry;
let heartbeat;
let connecting = false;
let currentJob;

async function connect() {
  clearTimeout(retry);
  if (connecting || socket && socket.readyState <= WebSocket.OPEN) return;
  connecting = true;
  try {
    const { token = '' } = await chrome.storage.local.get('token');
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    const candidate = new WebSocket(`${ENDPOINT}?token=${encodeURIComponent(token)}`);
    socket = candidate;
    candidate.onopen = () => {
      if (socket !== candidate) return candidate.close();
      candidate.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: 'heartbeat' }));
      }, 20000);
    };
    candidate.onmessage = event => {
      if (socket !== candidate) return;
      try { void handle(JSON.parse(event.data), candidate); } catch {}
    };
    candidate.onerror = () => {};
    candidate.onclose = () => {
      if (socket !== candidate) return;
      socket = undefined;
      clearInterval(heartbeat);
      if (currentJob) void cancelJob(currentJob);
      retry = setTimeout(connect, 2000);
    };
  } finally { connecting = false; }
}

async function handle(message, connection) {
  if (!message || typeof message.id !== 'string') return;
  if (message.type === 'cancel') {
    if (currentJob?.id === message.id) await cancelJob(currentJob);
    return;
  }
  if (message.type !== 'command') return;
  if (currentJob) return sendResult(connection, message.id, false, null, 'busy');
  if (!['status', 'generate'].includes(message.action) || message.payload?.backend !== 'studio') return;
  const job = { id: message.id, tabID: undefined, cancelled: false };
  currentJob = job;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://aistudio.google.com/*'] });
    if (!tabs.length) return sendResult(connection, job.id, false, null, 'no_tab');
    if (message.action === 'status') {
      for (const tab of tabs) {
        if (job.cancelled) return;
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { source: 'opencode-gemini-account', id: job.id, action: 'status' });
          if (result?.ok && result.result?.ready) return sendResult(connection, job.id, true, { ready: true });
        } catch {}
      }
      return sendResult(connection, job.id, true, { ready: false });
    }
    if (typeof message.payload.prompt !== 'string' || message.payload.prompt.length > 500000) return sendResult(connection, job.id, false, null, 'page_error');
    const preferred = tabs.find(tab => tab.active) ?? tabs[0];
    const tab = await chrome.tabs.create({ url: STUDIO, windowId: preferred.windowId, active: true });
    job.tabID = tab.id;
    const deadline = Date.now() + 60000;
    // Repeat readiness probes only. A generation command is sent once.
    while (true) {
      if (job.cancelled) throw new Error('cancelled');
      if (Date.now() >= deadline) throw new Error('page_not_ready');
      const state = await chrome.tabs.get(job.tabID);
      const url = state.url ?? state.pendingUrl ?? '';
      if (url && !url.startsWith('https://aistudio.google.com/')) throw new Error('page_not_ready');
      try {
        const ready = await chrome.tabs.sendMessage(job.tabID, { source: 'opencode-gemini-account', id: job.id, action: 'status' });
        if (ready?.ok && ready.result?.ready) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (job.cancelled) throw new Error('cancelled');
    const result = await chrome.tabs.sendMessage(job.tabID, {
      source: 'opencode-gemini-account', id: job.id, action: 'generate', payload: message.payload,
    });
    if (!job.cancelled) sendResult(connection, job.id, Boolean(result?.ok), result?.result ?? null, result?.code);
  } catch (error) {
    const code = ['cancelled', 'page_not_ready'].includes(error.message) ? error.message : 'page_error';
    sendResult(connection, job.id, false, null, code);
  } finally { if (currentJob === job) currentJob = undefined; }
}

async function cancelJob(job) {
  job.cancelled = true;
  if (job.tabID !== undefined) {
    try { await chrome.tabs.sendMessage(job.tabID, { type: 'cancel', id: job.id }); } catch {}
    // Only close the tab created for this job.
    try { await chrome.tabs.remove(job.tabID); } catch {}
  }
}

function sendResult(connection, id, ok, result, code) {
  if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'result', id, ok, result, code }));
}

function reconnect() {
  const previous = socket;
  socket = undefined;
  previous?.close();
  clearInterval(heartbeat);
  if (currentJob) void cancelJob(currentJob);
  void connect();
}

chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') void connect(); });
chrome.storage.onChanged.addListener(changes => { if (changes.token) reconnect(); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) return false;
  if (message?.type === 'bridge-reconnect') { reconnect(); sendResponse({ ok: true }); }
  if (message?.type === 'bridge-status') sendResponse({ connected: socket?.readyState === WebSocket.OPEN });
  return false;
});
void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void connect();
