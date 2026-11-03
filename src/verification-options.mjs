// Developer verification must target an explicitly selected model. A failed
// hardcoded default says nothing about another model already working in OpenCode.
export function verificationOptions(args, env = process.env) {
  let live = false, diagnoseRequest = false, selected;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live' && !live) live = true;
    else if (arg === '--diagnose-request' && !diagnoseRequest) diagnoseRequest = true;
    else if (arg === '--model' && selected === undefined) {
      if (typeof args[index + 1] !== 'string' || args[index + 1].startsWith('--')) throw new Error('--model 后需要明确的 Gemini 型号 ID');
      selected = args[++index];
    }
    else throw new Error('验收参数无效：使用 --live --model Gemini型号ID，可选 --diagnose-request');
  }
  if (!live) throw new Error('真实验收会使用模型额度，需要显式指定 --live');
  const value = selected ?? env.GEMINI_ACCOUNT_VERIFY_MODEL;
  const model = typeof value === 'string' ? value.trim().replace(/^aistudio-account\//, '') : '';
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error('请用 --model 显式指定验收型号，或设置 GEMINI_ACCOUNT_VERIFY_MODEL；不会自动选择或更换型号');
  return { model, diagnoseRequest };
}
