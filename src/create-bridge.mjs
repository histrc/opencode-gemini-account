import { BrowserBridge } from './browser.mjs';
import { ExtensionBridge } from './extension-bridge.mjs';

export function createBridge(settings) {
  return settings.connectionMode === 'extension' ? new ExtensionBridge(settings) : new BrowserBridge(settings);
}
