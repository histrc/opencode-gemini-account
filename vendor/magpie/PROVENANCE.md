# Vendored source

Source: https://github.com/BUKOWSKIREAL/magpie-gemini-web

Pinned commit: b5942b27990c6d4b83c714db7fecac257ff3b562

The files in lib and scripts are reused under the accompanying MIT licenses.
They implement download verification, local backend lifecycle, account setup,
model inventories, request conversion and citation handling. The Magpie desktop
application is neither bundled nor required. This folder includes no account
state, credentials, browser profiles or backend binaries.

Pinned backend versions:

- AIStudio2API official 0.2.19 (unreleased development candidate only)
- gemini-web2api-go 4.26.0-magpie.1

Newer releases exist; upgrades are a separate compatibility decision, not an
implicit change during installation.

Development candidate override: studio-release.json points to the official
Mag1cFall/AIStudio2API v0.2.19 assets, with archive SHA-256 digests from that
release's GitHub metadata. The Magpie studio-v0.2.19-magpie.1 release was not
available during candidate preparation; it is not an installation dependency.
The official artifacts do not include Magpie's legacy pre-0.2.17 request-body
database preservation patch. Therefore this candidate is restricted to new
isolated data roots or roots already using this exact candidate backend.
Existing stable installations are refused rather than automatically migrated.
studio-native.mjs also carries the upstream API_KEY_ACCOUNTS and
FIRST_EVENT_HEDGE_MODELS environment keys. The candidate pins
FIRST_EVENT_HEDGE=off in the service environment because upstream's legacy .env
migration otherwise removes that value and restores its automatic hedge policy.

Local adaptation: studio-page.mjs changes the stopped-page message to refer to
OpenCode instead of Magpie. The added Windows browser preparation and progress
orchestration live in the project's src directory, outside the vendored modules.
