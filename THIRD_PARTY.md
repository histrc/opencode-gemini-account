# References and dependencies

This project contains native OpenCode adapters and optional legacy browser UI
bridges. Version 0.7.0 vendors selected MIT-licensed Magpie backend management
and protocol modules in vendor/magpie, with their licenses and provenance.
Backend executables are downloaded from pinned releases and verified at setup;
the source archive contains no browser profiles, cookies or credentials.

References reviewed:

- OpenCode documentation: https://opencode.ai/docs/plugins/
- OpenCode source at tag `v1.19.5`, especially plugin hooks, provider custom
  fetch, authentication callback, and session retry handling:
  https://github.com/anomalyco/opencode/tree/v1.19.5
- Magpie Gemini Web, commit `b6f3cfb`, as a reference for user requirements and
  differences between webpage entry points:
  https://github.com/BUKOWSKIREAL/magpie-gemini-web
- Managed backend modules are reused from commit
  `b5942b27990c6d4b83c714db7fecac257ff3b562`; see vendor/magpie/PROVENANCE.md.
- AIStudio2API, commit `0302e77`, was reviewed as an early browser-bridge
  reference. Since 0.7.0 the default managed implementation downloads and runs
  the separately distributed AIStudio2API backend; its implementation remains
  upstream, rather than being copied into this project's JavaScript source:
  https://github.com/Mag1cFall/AIStudio2API

Runtime dependencies, downloaded by npm:

- Playwright Core 1.64.1 — Apache-2.0
- Ajv 8.20.0 — MIT
- Zod 4.6.7 — MIT
- ws 8.22.1 — MIT
- @opencode/ai and @opencode/plugin 2.2.5 — MIT
- Effect 4.0.6 — MIT

Extension lifecycle and permissions references:

- https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
- https://developer.chrome.com/docs/extensions/reference/api/alarms
- https://developer.chrome.com/docs/extensions/reference/api/tabs

Development dependencies include the OpenCode plugin types, the Vercel AI SDK,
its OpenAI-compatible provider, TypeScript, and Node type definitions. Their
licenses remain those of their respective packages. Exact versions and
transitive dependencies are recorded in `package-lock.json`.

The plugin's native chat adapter uses an OpenAI-compatible wire format in
process. Its managed backend executables expose loopback HTTP APIs. The image
integration also starts a temporary token-protected loopback adapter to use
OpenCode 2.2.5's bundled Google image protocol. Users do not manually configure
or deploy these services. Executables, browser binaries and account data are
not included in the source repository.
