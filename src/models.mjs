import { BridgeError } from './errors.mjs';

export const DEFAULT_STUDIO_MODELS = Object.freeze(['gemini-3.5-flash-lite']);
export function isStudioModelID(id) {
  return typeof id === 'string' && /^gemini-[a-z0-9][a-z0-9._-]{0,90}$/.test(id) && !id.endsWith('-tools-experimental');
}

export function modelCatalog(settings = {}) {
  const models = {
    'studio-current': { name: 'AI Studio · 网页默认模型（文本）', backend: 'studio', tools: false },
  };
  if (settings.connectionMode === 'extension') return models;
  models['web-current'] = { name: 'Gemini Web · 网页默认模型（文本）', backend: 'web', tools: false };
  if (settings.experimentalTools) {
    models['studio-tools-experimental'] = { name: 'AI Studio · 工具模拟（实验性）', backend: 'studio', tools: true };
    models['web-tools-experimental'] = { name: 'Gemini Web · 工具模拟（实验性）', backend: 'web', tools: true };
  }
  for (const upstreamModel of settings.studioModels ?? DEFAULT_STUDIO_MODELS) {
    const id = `studio-${upstreamModel}`;
    models[id] = { name: `AI Studio · ${upstreamModel}（校验型号）`, backend: 'studio', tools: false, upstreamModel };
    if (settings.experimentalTools) models[`${id}-tools-experimental`] = {
      name: `AI Studio · ${upstreamModel} · 工具模拟（实验性）`, backend: 'studio', tools: true, upstreamModel,
    };
  }
  return models;
}

export function resolveModel(id, settings = {}) {
  if (typeof id !== 'string') throw new BridgeError('未知模型。请在 /models 选择 Gemini Account 的入口。');
  // Recognize disabled tool entries without enabling them as a side effect.
  const all = modelCatalog({ ...settings, experimentalTools: true });
  if (!Object.hasOwn(all, id)) throw new BridgeError('未知模型或模型尚未配置。请在 /models 选择已注册的入口。');
  if (all[id].tools && !settings.experimentalTools) throw new BridgeError('请先启用 experimentalTools 并重启 OpenCode');
  return all[id];
}

export function siteForModel(settings, backend, upstreamModel) {
  if (!Object.hasOwn(settings.sites, backend)) throw new BridgeError('未知网页入口');
  const site = { ...settings.sites[backend], disableSearch: backend === 'studio' && settings.studioSearch === 'off', visionMode: backend === 'web' ? settings.webVisionMode : undefined };
  if (!upstreamModel) return site;
  if (backend !== 'studio' || !isStudioModelID(upstreamModel) || !settings.studioModels.includes(upstreamModel)) {
    throw new BridgeError('所选网页模型尚未配置');
  }
  const url = new URL(site.url);
  url.searchParams.set('model', upstreamModel);
  return { ...site, url: url.href, expectedModel: upstreamModel };
}
