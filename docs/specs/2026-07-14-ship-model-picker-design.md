# Ship It — Choosable Ship Models + Procedural Hue Tint

**Date:** 2026-07-14
**Status:** Proposed (awaiting review)
**Scope:** Replace the single vendored rocket with a **choice of 4 low-poly spaceship models**
(Quaternius, CC0), selectable from `ship.config.json`, and repurpose the existing `color` field to
**procedurally hue-shift** the chosen model (and the UI accent). Touches `launchpad/`, `board/`, the
answer-key workflows in `starter/`, and the PINNED contracts in `CLAUDE.md`.

---

## 1. What we're building

Today every learner's ship is the **same** poly.pizza rocket, tinted by a `color`. Two changes:

1. **Ship choice becomes an identity axis.** `ship.config.json` gains `shipModel` — one of four
   distinct low-poly spaceships. The learner picks a *shape*, not just a colour.
2. **`color` is retained but repurposed.** Instead of flat-tinting a plain rocket, `color` now
   **hue-rotates** the chosen model's baked paint (preserving its shading and dark detailing) and
   drives the UI accent (badge, overlay, loading spinner) and the board's rendered ship.

Net identity is now **model × colour** — a stronger version of the "60 distinct ships" pillar than
either axis alone. The board's shared orbit renders each learner's **actual chosen model**, hue-shifted
to match — so the projector view matches each learner's own site.

This is an **additive** change to the pinned contract: `color` stays (same hex regex), `shipModel` is
new. The board event contract gains an optional `shipModel`; old events still render (default `fighter`).

---

## 2. The four ships

All four are Quaternius CC0 low-poly spaceships from poly.pizza (each page is titled only
"Spaceship"; ids/labels below are ours). Each is a single mesh with a baked texture atlas — **not**
vertex-tintable, which is why we hue-rotate rather than multiply.

| id | poly.pizza | look | `baseHue`° | factory paint (reference only) |
|---|---|---|---|---|
| `fighter` | `uCeLfsdmNP` | orange/grey long-nose starfighter | 25 | `#f97316` |
| `interceptor` | `Jqfed124pQ` | pink/black delta-wing stealth jet | 330 | `#ec4899` |
| `hauler` | `VSxUAFhzbA` | green/orange blocky cargo drone | 140 | `#4ade80` |
| `scout` | `u105mYHLHU` | yellow/black round probe pod | 48 | `#facc15` |

`baseHue` = the model's dominant paint hue in degrees. It lets a given `color` land predictably: the
hue-shift rotation is `targetHue(color) − baseHue`, so `color: '#22d3ee'` (cyan) turns **every** ship
cyan regardless of its factory paint. The "factory paint" column is **informational only** (what the
model looks like unshifted) — it is **not** stored in the registry or used in code; `color` drives the
accent.

Direct GLB sources (Quaternius, CC0, verified single-mesh `glTF-binary`):
- fighter — `https://static.poly.pizza/e8817981-bfc4-448d-822f-5b76a5983675.glb`
- interceptor — `https://static.poly.pizza/fb4a47c7-5453-433d-959d-0d3903b578e3.glb`
- hauler — `https://static.poly.pizza/9dd50f84-345d-418f-bb58-0cb63fd091e6.glb`
- scout — `https://static.poly.pizza/0843ab59-1800-4d96-9cc7-b4d6afbecf21.glb`

---

## 3. Config contract change

**Before:** `{ shipName, color, emblem }`
**After:** `{ shipName, color, shipModel, emblem }`

| field | rule | on bad value |
|---|---|---|
| `shipName` | non-empty string ≤ 24 chars | ABORT (unchanged) |
| `color` | hex `/^#[0-9a-fA-F]{6}$/` | ABORT (unchanged) |
| `shipModel` | **new** — one of `fighter · interceptor · hauler · scout` | ABORT (strict gate); browser & board default to `fighter` |
| `emblem` | one of `comet · bolt · star · ring · delta · phoenix` | ABORT (unchanged) |

Starter `ship.config.json`:
```json
{
  "shipName": "Nebula Runner",
  "color": "#22d3ee",
  "shipModel": "fighter",
  "emblem": "comet"
}
```

---

## 4. Shared ship registry

Pure data + one helper, following the repo's existing "duplicate the small pure core across the
`src`/`client` bundling boundary" precedent (`COLOR_RE` is already duplicated between launchpad and
board). Two copies, kept byte-identical:

```js
// launchpad/src/ship-schema.js  AND  board/src/ships.js
export const SHIPS = [
  { id: 'fighter',     file: 'fighter.glb',     label: 'Fighter',     baseHue: 25  },
  { id: 'interceptor', file: 'interceptor.glb', label: 'Interceptor', baseHue: 330 },
  { id: 'hauler',      file: 'hauler.glb',      label: 'Hauler',      baseHue: 140 },
  { id: 'scout',       file: 'scout.glb',       label: 'Scout',       baseHue: 48  },
];
export const SHIP_IDS = SHIPS.map((s) => s.id);
export const DEFAULT_SHIP = 'fighter';

// Rotation (radians) to turn a model of baseHue° into the hue of `color`.
// Parse hex → HSL; if saturation < ~0.15 return 0 (greyscale color leaves the
// baked paint alone); else return ((hue(color) − baseHue) degrees) × π/180.
export function hueShiftFor(color, baseHue) { /* per the comment above */ }
```

---

## 5. Procedural hue-shift (the one visual mechanism)

A single technique used identically on the launchpad site and the board: inject a hue rotation into
the standard material's fragment shader via `material.onBeforeCompile`, after the base-colour texture
is sampled. Low-saturation texels (black cockpit, grey trim) barely move; saturated paint rotates to
the target hue. Rotation amount = `hueShiftFor(color, model.baseHue)`, passed as a `uHue` uniform.

```js
function applyHueShift(material, radians) {
  if (!radians) return material;              // greyscale color → no-op
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHue = { value: radians };
    shader.fragmentShader =
      'uniform float uHue;\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         { // rotate hue of diffuseColor.rgb about the luma axis
           float a = uHue;
           mat3 m = mat3(0.299,0.587,0.114, 0.299,0.587,0.114, 0.299,0.587,0.114)
             + cos(a)*mat3(0.701,-0.587,-0.114, -0.299,0.413,-0.114, -0.299,-0.587,0.886)
             + sin(a)*mat3(0.168,0.330,-0.497, -0.328,0.035,0.292, 1.250,-1.050,-0.203);
           diffuseColor.rgb = clamp(m * diffuseColor.rgb, 0.0, 1.0);
         }`,
      );
  };
  material.needsUpdate = true;
  return material;
}
```

**Risk & documented fallback:** a hue rotation could land unpleasantly on a specific model.
Implementation MUST screenshot each of the 4 models at ≥3 hues (e.g. cyan, magenta, lime) and eyeball
them. If any model looks broken under rotation, that model falls back to **accent-only** (baked paint
untouched; `color` drives only the UI chrome, not the mesh) — recorded per-model, not a global toggle.

---

## 6. Launchpad changes (`launchpad/`)

The M1 loading/fallback behaviour (spinner while loading; on GLB error, tear down the scene and show
the static card) is **kept** — only re-parameterised by the selected model.

| file | change |
|---|---|
| `src/ship-schema.js` | add `SHIPS`/`SHIP_IDS`/`DEFAULT_SHIP`/`hueShiftFor`; `validateConfig` requires `shipModel ∈ SHIP_IDS`; `toRenderParams` returns `shipModel` (default `fighter`). `color`/`emblem`/`shipName` logic unchanged. |
| `ship.config.json` | add `"shipModel": "fighter"`. |
| `src/scene.js` | load `${shipModel}.glb` (from the registry `file`); **no `tint()`** — instead `applyHueShift(mat, hueShiftFor(color, baseHue))` per material; replace height-only `fitToHeight` with **fit-by-largest-dimension** (these ships are wide/flat, not tall). Spinner + `onError` static-fallback unchanged. |
| `src/overlay.js`, `src/fallback.js` | **no structural change** — still read `params.color` for `--ship-color` and `params.emblem`. (Accent = `color`, retained.) |
| `public/` | remove `rocket.glb`; add `fighter.glb`, `interceptor.glb`, `hauler.glb`, `scout.glb`. |
| `src/ship-schema.test.mjs`, `scripts/preflight.test.mjs` | add cases: valid `shipModel`, unknown `shipModel` → ABORT, missing → ABORT (strict) / default (lenient). |
| `README.md` | document the 4 ships + that `color` now tints the model. |
| `CREDITS.md` (new) | Quaternius, CC0, the 4 poly.pizza source URLs. |

`fitByMaxDimension(object3d, target)`: compute the bounding box, scale so `max(size.x,size.y,size.z)
= target` (start `target ≈ 3.0`, tune visually), recentre. Replaces `fitToHeight`.

---

## 7. Board changes (`board/`) — the bigger lift

The board must render each learner's **real chosen model**, hue-shifted, in place of the procedural
rocket — without loading a GLB per ship (60 ships → load the 4 templates **once**).

| file | change |
|---|---|
| `src/ships.js` (new) | identical `SHIPS`/`SHIP_IDS`/`DEFAULT_SHIP`/`hueShiftFor` copy. |
| `src/room.js` | `sanitizeEvent` gains lenient `shipModel` (∈ `SHIP_IDS`, else `DEFAULT_SHIP`), added to the roster entry. |
| `client/scene.js` | **preload** the 4 GLBs once (`GLTFLoader` + `Promise.all`) before first render; hold a template group per id. Pass the templates into `createShip`. The re-create guard changes from `rec.data.color !== s.color` to also re-create on `shipModel` change. Shared-resource disposal (below). |
| `client/ship-mesh.js` | `createShip({ callsign, color, shipModel, template })` clones the template, **clones each material** and `applyHueShift`es it, keeps the callsign label sprite, the additive exhaust trail, and `setTrail`/`setGrounded`/`setEmissiveBoost` (they now operate on the model's cloned material via `userData.mat`). The clone's material gets `emissive` set to `color` at `baseEmissive` (≈0.35) so the launch bloom and the grounded-red still read exactly as they did on the rocket. |
| `client/fallback.js` | roster chip keeps `color`; optionally append the ship `label`. |
| `client/public/` (new) | vendor the same 4 GLBs (Vite copies `public/` → `dist/`). |
| `test/room.test.js` | add `shipModel` sanitize cases (valid / unknown→default / missing→default). |
| `test/server.test.js` | assert a posted `shipModel` survives into the ws roster. |

**Shared-resource disposal (load-bearing).** Ship clones share the template's geometry and textures.
The existing `disposeObject3D` disposes geometry **and** textures — which would break sibling ships the
first time one is removed. Fix: per-ship removal disposes **only the cloned materials** (not their
shared textures, not the shared geometry) plus the ship's own label/trail (which it uniquely owns).
The 4 templates' geometries + textures are disposed **once**, on full scene teardown.

**Async preload vs. `createScene`'s sync contract.** `createScene(container, {onLiftoff})` currently
returns synchronously and `main.js` calls `view.update(lastShips)` immediately. Ships that arrive
before the templates finish loading are buffered (store `lastList`) and rendered once preload
resolves; `update()` stays callable throughout. The reduced-motion / no-WebGL fallback path
(`createFallback`) is unaffected — it never loads GLBs.

**Preload failure.** If the GLB preload rejects (missing asset, decode error), the board logs and
swaps to the existing plain-list `createFallback` view rather than a blank scene — reusing the
degradation path the board already ships, so a vendoring mistake fails legibly instead of white.

---

## 8. Answer-key workflow changes (`starter/`)

The `cicd3`/`cicd4` workflows extract `color` from `ship.config.json` and POST it. To get the chosen
model into orbit they must also send `shipModel`. Because the board defaults missing `shipModel`,
these edits are additive (an un-updated fork still renders a fighter).

For both `starter/workflows/deploy.cicd3.yml` and `deploy.cicd4.yml`, in each `id: cfg` step add:
```yaml
- id: cfg
  run: |
    echo "color=$(jq -r .color ship.config.json)" >> "$GITHUB_OUTPUT"
    echo "model=$(jq -r .shipModel ship.config.json)" >> "$GITHUB_OUTPUT"
```
and add `\"shipModel\":\"${{ steps.cfg.outputs.model }}\"` to each event JSON payload (pad, test-fail,
liftoff). `cicd1`/`cicd2` don't POST to the board — no change.

---

## 9. Docs & pinned-contract updates

| file | change |
|---|---|
| `CLAUDE.md` | update the PINNED **learner-facing contract** (config = `{ shipName, color, shipModel, emblem }`; add the `shipModel` enum) and the PINNED **event contract** (add `shipModel`; note the board renders the model, hue-shifted by `color`). |
| `docs/learner-per-session-commands.md` | mention picking `shipModel` when customising. |
| `starter/README.learner.md` | mention the 4 ships. |
| `launchpad/README.md` | as §6. |

**Out of scope (flag, don't touch):** the **slides repo** `~/repo/slides-devops-bootcamp` quotes
these contracts verbatim and lives in a separate repo — note the drift for the instructor, do not edit
it here. No learner has forked the pre-change schema yet (the sync-to-`Infratify/shipit-launchpad`
automation is milestone M6, unbuilt), so changing the config shape now is safe.

---

## 10. Testing & verification

- **Unit (`node --test`):** launchpad `ship-schema`/`preflight` gain `shipModel` cases; board `room`
  gains `shipModel` sanitize cases + `server` roster round-trip. `hueShiftFor` gets direct cases
  (known hex → expected radians; greyscale → 0).
- **Launchpad visual (required):** `vite build` + `vite preview`, drive with Playwright — confirm each
  of the 4 models loads and renders, the spinner shows during load, and the GLB-error path still shows
  the static card. Screenshot each model at ≥3 hues for the §5 risk check.
- **Board visual (required):** build + run the server, POST events for several callsigns with
  different `shipModel`+`color`, confirm the orbit shows the **right hue-shifted models**, the launch
  beat/trail/label still work, and removing a ship doesn't corrupt its neighbours (shared-resource
  disposal check).
- **No new test framework** — Node's built-in runner only. No Playwright in the repo's test script
  (visual checks are manual/driver-based, per the existing `scripts/smoke.sh` precedent).

---

## 11. File-by-file summary

**Launchpad:** `src/ship-schema.js` (registry+validate), `src/scene.js` (load+hue+fit),
`ship.config.json`, `public/*.glb` (−rocket, +4), `src/ship-schema.test.mjs`,
`scripts/preflight.test.mjs`, `README.md`, `CREDITS.md`.

**Board:** `src/ships.js` (new), `src/room.js` (sanitize), `client/scene.js` (preload+dispose),
`client/ship-mesh.js` (clone+hue), `client/fallback.js` (label), `client/public/*.glb` (+4),
`test/room.test.js`, `test/server.test.js`.

**Starter/docs:** `starter/workflows/deploy.cicd3.yml`, `deploy.cicd4.yml`,
`starter/README.learner.md`, `docs/learner-per-session-commands.md`, `CLAUDE.md`.
