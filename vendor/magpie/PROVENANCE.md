# Vendored source

Source: https://github.com/BUKOWSKIREAL/magpie-gemini-web

Pinned commit: b5942b27990c6d4b83c714db7fecac257ff3b562

The files in lib and scripts are reused under the accompanying MIT licenses.
They implement download verification, local backend lifecycle, account setup,
model inventories, request conversion and citation handling. The Magpie desktop
application is neither bundled nor required. This folder includes no account
state, credentials, browser profiles or backend binaries.

Pinned backend versions:

- AIStudio2API 0.2.18-magpie.1
- gemini-web2api-go 4.26.0-magpie.1

Newer releases exist; upgrades are a separate compatibility decision, not an
implicit change during installation.

Local adaptation: studio-page.mjs changes the stopped-page message to refer to
OpenCode instead of Magpie. The added Windows browser preparation and progress
orchestration live in the project's src directory, outside the vendored modules.
