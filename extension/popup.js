const token = document.querySelector('#token');
const status = document.querySelector('#status');
const saved = await chrome.storage.local.get('token');
token.value = saved.token ?? '';
await refresh();

document.querySelector('#save').addEventListener('click', async () => {
  const value = token.value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    status.textContent = '令牌格式不正确';
    return;
  }
  await chrome.storage.local.set({ token: value });
  await chrome.runtime.sendMessage({ type: 'bridge-reconnect' });
  status.textContent = '已保存，正在连接…';
  setTimeout(refresh, 800);
});

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'bridge-status' });
  status.textContent = state?.connected ? '已连接本机 OpenCode' : '未连接；请先启动 OpenCode/连接命令';
}
