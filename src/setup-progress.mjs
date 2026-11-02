import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { openProgressPage } from '../vendor/magpie/lib/studio-page.mjs';

const phases = ['service', 'browser', 'login', 'generation', 'done'];
export async function createSetupProgress(directory) {
  let state = { phase: 'service', detail: '准备本机 AI Studio 后端' };
  let write = Promise.resolve();
  let closing;
  const page = await openProgressPage(snapshot);
  function snapshot() {
    const index = state.phase.startsWith('browser-') ? 1 : Math.max(0, phases.indexOf(state.phase));
    const labels = ['本机 AI Studio 后端', '登录浏览器（首次约 470 MiB）', '本人完成 Google 登录', '启动模型与刷新目录'];
    return {
      title: 'OpenCode · AI Studio 连接进度',
      note: '后端和登录浏览器只需准备一次。当前页面显示进度，Google 登录会在另一个窗口中完成。',
      steps: labels.map((label, step) => ({ label, state: step < index ? 'done' : step === index ? state.error ? 'failed' : 'active' : 'pending',
        ...(step === index ? { detail: state.detail, ...(state.phase === 'browser-download' ? { received: state.received ?? 0, total: state.total ?? 0 } : {}) } : {}),
      })),
      done: state.phase === 'done', doneText: '账号连接成功，请回到 OpenCode 选择模型。', error: state.error,
    };
  }
  async function persist() {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'setup-studio-progress.json');
    const temporary = file + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify({ ...snapshot(), detail: state.detail, phase: state.phase, received: state.received, total: state.total, updatedAt: Date.now() }), { mode: 0o600 });
    await rename(temporary, file);
  }
  function report(update) {
    state = { ...state, ...update };
    write = write.catch(() => {}).then(persist);
  }
  report(state);
  return {
    url: page.url, report,
    async finish(error) {
      if (error) {
        const message = error.code === 'STUDIO_ACCOUNT_BUSY' || typeof error.code === 'string' && error.code.startsWith('CAMOUFOX_') ? error.message : 'AI Studio 连接没有完成，请查看命令窗口或后端日志后重试。';
        report({ error: message });
      } else report({ phase: 'done', detail: '连接成功' });
      await write;
      closing = setTimeout(page.close, 120000); closing.unref?.();
    },
    close() { clearTimeout(closing); page.close(); },
  };
}
