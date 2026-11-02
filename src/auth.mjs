export function loginLabel(backend, connectionMode = 'browser') {
  return `登录 ${backend === 'studio' ? 'Google AI Studio' : 'Gemini 网页版'}（${connectionMode === 'extension' ? 'Edge 扩展' : '独立浏览器'}）`;
}

export function createAuthMethods(bridge, settings) {
  const backends = settings.connectionMode === 'extension' ? ['studio'] : ['studio', 'web'];
  return backends.map(backend => ({
    type: /** @type {const} */ ('oauth'), label: loginLabel(backend, settings.connectionMode),
    authorize: async () => {
      const page = await bridge.openLogin(backend);
      return {
        url: settings.sites[backend].url, method: /** @type {const} */ ('auto'),
        instructions: settings.connectionMode === 'extension'
          ? '请在正常 Edge 中打开 AI Studio，确认扩展已安装并填入配对令牌。登录由正常浏览器完成。'
          : '请在刚打开的独立浏览器窗口登录 Google，完成网页提示，等待聊天输入框出现。请保留窗口，插件会自动确认。无需粘贴 Cookie 或 API Key。',
        callback: async () => {
          try {
            await bridge.waitLogin(backend, page);
            return { type: /** @type {const} */ ('success'), key: 'local-browser-session-v1' };
          } catch { return { type: /** @type {const} */ ('failed') }; }
        },
      };
    },
  }));
}
