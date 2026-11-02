// Fully offline fixture. The production provider, loopback server, worker and
// content script run against intercepted pages via a test chrome.tabs adapter.
import { createPlugin } from '../../src/plugin.mjs';
import { createV2Plugin } from '../../src/plugin-v2.mjs';
import { ExtensionBridge } from '../../src/extension-bridge.mjs';
import { extensionBrowser } from './extension-browser.mjs';

class OfflineExtensionBridge extends ExtensionBridge {
  constructor(settings) { super(settings, { port: 0 }); }
  async start() {
    await super.start();
    this.fixture ??= extensionBrowser({ directory: this.settings.directory, port: this.server.http.address().port });
    await this.fixture;
  }
  async dispose() {
    const fixture = await this.fixture?.catch(() => undefined);
    await fixture?.close();
    await super.dispose();
  }
}
const create = settings => new OfflineExtensionBridge(settings);
export default { ...createV2Plugin(create), server: createPlugin(create) };
