# Versioning & stability

`@mnemopay/sdk` follows [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`.

- **PATCH** (`1.11.x`) — bug fixes, perf, docs. No public API changes.
- **MINOR** (`1.x.0`) — new modules / additive API. Existing **Stable** API stays backward-compatible.
- **MAJOR** (`x.0.0`) — breaking changes to **Stable** API. Announced with a migration note.

## Stability tiers

Each module carries a stability tier (see the table in [README.md](README.md#module-stability)). The tier sets how much the public API may move *between minor versions*:

| Tier | Promise | Breaking changes |
|---|---|---|
| **Stable** | Production-ready, battle-tested. | Only in a MAJOR bump, with migration notes. |
| **Beta** | Usable in production; shape is settling. | Possible in a MINOR bump; called out in the changelog. |
| **Alpha** | Experimental — "build with us." | May change or be removed in any MINOR; pin an exact version. |

A module's tier only goes up (Alpha → Beta → Stable) once its API has held steady across releases. It does not regress.

## What "Stable" covers

For Stable modules the following are part of the public contract and won't break without a MAJOR bump:

- Exported function/class names and their call signatures.
- Exported type shapes that appear in those signatures.
- Documented runtime behavior (return values, thrown errors, audit events emitted).

Not covered (may change in any release): internal module paths not listed in `package.json#exports`, `private` class members, the exact text of log/error messages, and anything imported via a deep path that bypasses the published subpath exports.

## Pinning

- **Stable** modules: a caret range (`^1.11.0`) is safe.
- **Beta** modules: caret is fine but read the changelog on minor upgrades.
- **Alpha** modules: pin an exact version (`1.11.1`, no caret) — the API may shift in the next minor.

## Deprecation

A Stable API marked for removal is first deprecated (kept working, flagged in docs + JSDoc `@deprecated`) for at least one MINOR cycle before removal in the next MAJOR.
