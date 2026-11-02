export class BridgeError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

// Only classify rendered error controls, never arbitrary model answers. Do not
// expose raw upstream text: it may echo prompts, account details, or headers.
export function classifyPageError(text) {
  if (/permission denied|permissions? denied|access denied|权限遭拒|没有权限|无权访问/i.test(text)) {
    return new BridgeError('网页拒绝了当前账号或模型的访问权限。请在保留的页面检查模型资格和访问模式。', 403, 'permission_denied');
  }
  if (/quota|usage limit|rate.?limit|too many requests|配额|用量上限|请求频率|达到.{0,12}上限/i.test(text)) {
    return new BridgeError('网页额度或请求频率受限。请等待页面允许后手动重试；插件没有自动重发。', 429, 'quota_limited');
  }
  if (/model.{0,40}(not found|unavailable|not supported)|模型.{0,16}(不可用|不存在|不支持)/i.test(text)) {
    return new BridgeError('网页模型当前不可用。请在 /models 选择其他入口，或检查配置的模型 ID。', 422, 'model_unavailable');
  }
  return new BridgeError('网页提示生成失败。请检查保留的页面；插件没有自动重试。', 422, 'upstream_ui_error');
}
