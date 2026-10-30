# Licensing

SoloCart is a composition of three codebases under different licenses. The
root [LICENSE](./LICENSE) (MIT) covers the original SoloCart work **only** —
it does not relicense the ports described below. This file is the map; each
derived file's header also states its origin. It is a good-faith summary, not
legal advice.

## Summary

| Component | Where | License |
| --- | --- | --- |
| SoloCart original | `server.mjs`, the orders/PayPal/session code under `server/`, the desk UI under `public/` (styling, views, `pay.html`), `tests/`, `docs/`, `scripts/` | MIT — [LICENSE](./LICENSE) |
| Butler-derived | the ported files under `server/ai/` and `server/integrations/` and `server/summaries/` whose headers say "port of Butler", plus the state machine in `public/byte.js` | **AGPL-3.0** — [LICENSES/AGPL-3.0.txt](./LICENSES/AGPL-3.0.txt) |
| Morrow-derived | `server/offline/` (protocol + redemption ledger) and all of `apps/morrow-mobile/` | no upstream license — see below |
| Third-party code | vendored libraries, the Decimen fountain core, npm dependencies | their own terms — [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) |

## Butler-derived work is AGPL-3.0

[Butler](https://github.com/Anasabubakar/Butler-2.0) is free software under the GNU
Affero General Public License v3.0, and so are the parts of this repository
ported from it. Look for `Port of Butler's …` / `ported from Butler` in a file
header — those files include:

- `server/ai/assistant.mjs`, `memory.mjs`, `providers.mjs`, `recall.mjs`, `rules.mjs`
  (Butler's command, memory, provider-fallback, recall and rules modules,
  retargeted at a seller desk)
- `server/integrations/vault.mjs`, `mcp.mjs`, `outbound.mjs`, `recipes.mjs`
  (secrets vault, MCP client, SSRF-guarded outbound HTTP, recipes with an
  approval gate)
- `server/summaries/brief.mjs`, `recap.mjs`, `spending.mjs`, `streaks.mjs`
  (AI-free morning brief, weekly recap, totals, streaks)
- `public/byte.js` — the state names, durations and transitions follow
  Butler's little-butler behavior spec; the artwork is SoloCart's own SVG.

`server/integrations/jobs.mjs` (the SQLite job queue) and
`server/integrations/tools.mjs` are new code written for SoloCart — Butler has
no generic queue — though they follow Butler's scheduling and approval
semantics; they are marked as such in their headers.

Why this matters: AGPL-3.0 is a copyleft license with a network clause. If
you distribute this repository, or offer it to others as a service, the
AGPL's obligations apply to the Butler-derived parts (and, in practice, to the
combined work). Do not assume the whole repository is MIT because of the root
LICENSE. Full text: [LICENSES/AGPL-3.0.txt](./LICENSES/AGPL-3.0.txt).

Butler's brand assets — its logos and the Little Butler character — are **not**
covered by that license. They remain © Anas Abubakar, all rights reserved,
and are **not included in this repository**: Byte's behavior is the ported
engine, the art is SoloCart's own.

## Morrow-derived work has no upstream license

The offline-payments protocol port (`server/offline/`) and the Expo app
(`apps/morrow-mobile/`) derive from the Morrow repository, which ships **no
LICENSE file and no license statement** — its authors grant no open-source
permission by default, and copyright stays with them. This repository includes
those derivatives with attribution for a hackathon demonstration, and nothing
here changes who owns them.

Practical consequences: you may run and inspect this repository as delivered,
but the Morrow-derived parts carry **no license grant from us and none from
upstream**. If Morrow ever publishes a license, that license governs its
derived code and this section should be updated to point at it.

## Third-party code

Vendored and npm dependencies keep their own licenses (MIT, Apache-2.0, and
others). They are inventoried in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), including the MIT notice
for the Decimen fountain core inside the mobile app.

## Tests and fixtures

The test suite (`tests/`, `apps/morrow-mobile/src/**/*.test.ts`) and the shared
vector fixture (`tests/fixtures/offline-vectors.json`) are part of the
respective components above: root tests are MIT, the mobile app's tests follow
the Morrow-derived section. The vector fixture contains fixed test keys that
are never used for a real payment.
