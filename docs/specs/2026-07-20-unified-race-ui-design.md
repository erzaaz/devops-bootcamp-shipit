# Unified 2D Race UI — shared track, live progress, operator console

**Date:** 2026-07-20 · **Status:** approved (user delegated self-review)
**Supersedes** the race *rendering* half of `2026-07-18-typing-race-mode-design.md`.
Server race authority, roster gate, session corpora, and the operator HTTP endpoints stay as
designed there — this spec changes how the race is *drawn*, how progress is *reported*, and adds
an operator page so race control needs no curl.

## Goals (user-approved decisions)

1. **One race view for everyone.** Projector (Mission Control) and learner cockpit (`/play`)
   render the race with the *same* DOM component — same rows, same sprites, same motion.
2. **2D rows layout.** One row per racer, stacked top-to-bottom; ships fly left→right toward a
   finish line at the right edge. Scales to 40+ racers by shrinking rows, never scrolling.
3. **Own ship visible.** Each racer sees their own row highlighted (and slightly taller), with a
   small rendered model of *their* ship (their `shipModel` + `color`).
4. **Live, smooth movement.** Ships glide per keystroke, not per completed prompt: the cockpit
   reports fractional progress on the current prompt; positions animate continuously.
5. **Proper operator UI.** A `/operator` page with START (session picker), RESET, and
   ORBIT/RACE view buttons replaces curl.

Non-goals: the 3D orbit view is untouched (spectacle lives there); no persistence; no join auth
beyond the existing roster gate; no anti-cheat beyond the existing monotonic `completed` guard.

## Architecture

```
board/client/
  race-track.js      NEW  shared DOM race component (projector + cockpit)
  race-layout.js     NEW  pure math: progress fraction, lane order, ranks (node-tested)
  ship-sprite.js     NEW  GLB → cached 2D sprite data-URLs (WebGL once, then plain <img>)
  race-track.css     NEW  component styles, imported by both entry CSS files
  operator.html/.js/.css  NEW  instructor console page
  main.js            MOD  projector swaps createRaceView/createRaceFallback → createRaceTrack
  play.js/.html/.css MOD  cockpit = race-track on top + typing dock at bottom
  race-view.js       DEL  (Three.js race scene — superseded)
  race-fallback.js   DEL  (DOM leaderboard — the new component is its own fallback)
  track.js           DEL  (world-coordinate math — superseded by race-layout.js)
  *.test.js for deleted files DEL; race-layout.test.js NEW
board/src/
  race.js            MOD  racer gains display-only `frac`
  app.js             MOD  WS `progress` accepts `frac`; static route alias /operator
  messages.js        MOD  raceMsg ships include `frac`
board/test/race.test.js  MOD  frac behaviour
board/vite.config.js MOD  third rollup input: operator.html
```

## `race-track.js` — the shared component

```js
createRaceTrack(container, { me = null } = {})  // → { update(raceState), dispose() }
// raceState = the WS race message: { phase, total, ships: [...] }
// ships[i] = { callsign, completed, frac, finishedAt, color, shipModel }
```

Same `{ update, dispose }` shape as every other view so `main.js` swaps it freely.

- **Rows.** Flex column filling `container`. Row order is **stable alphabetical** by callsign —
  rows never reorder mid-race (ships move only horizontally; rank is shown as a number chip that
  updates). Each row: rank chip · `@callsign` label · track lane with finish line · ship sprite ·
  progress readout (`7.4/12`-style, one decimal).
- **Responsive to 40+.** Rows are `flex: 1 1 0` with `min-height` ≈ 10px and `max-height` ≈ 48px,
  so 40 rows split any viewport evenly with no scrolling. Font sizes `clamp()`ed; the callsign
  label hides in dense mode, which triggers at 25+ racers (full name stays as `title`). The `me` row gets
  `flex-grow: 2` plus accent highlight so it stays findable at any density.
- **Motion.** Ship position `left: calc(p × (100% − sprite width))` where
  `p = progressOf(completed, frac, total)`. CSS `transition: left 150ms linear`; with ~10 Hz
  fractional updates this reads as continuous gliding. `prefers-reduced-motion: reduce` disables
  the transition (positions still update — discrete steps, no animation). No
  `requestAnimationFrame`, no WebGL at render time — the component IS the reduced-capability
  fallback, which is why `race-fallback.js` dies.
- **Phases.** `idle`: dimmed rows + "WAITING FOR LAUNCH…" banner. `running`: live — and once any
  racer lands, the banner shows podium medals as they arrive (a ghost racer who never finishes
  blocks the server's `finished` phase forever, so winners must not wait for it). `finished`:
  same podium banner, top 3 by `finishedAt`. Finished ships show `✦` + final rank on their row.
- **Dark-only**, with its own local CSS custom properties (not the light/dark scheme in
  `style.css`/`play.css`) — consistent with the board's dark stage pages.

## `race-layout.js` — pure, node-tested

- `progressOf(completed, frac, total)` → 0..1, clamped, `frac` counted only below `total`.
- `laneOrder(ships)` → stable alphabetical callsign list (replaces `race-view.js`'s `laneOf`).
- `ranks(ships)` → Map callsign→rank: finished ships by `finishedAt` first, then by
  `completed + frac` descending, ties alphabetical.

## `ship-sprite.js` — GLB snapshot sprites

- `shipSprite(shipModel, color)` → `Promise<string|null>` (PNG data-URL, or `null` = no WebGL /
  load failure). Cache `Map` keyed `` `${shipModel}|${color}` `` — one render per pair ever.
- Implementation: lazy singleton offscreen `WebGLRenderer` (~64×64, alpha), reuses
  `preloadShipTemplates()` + `createShip()` from `ship-mesh.js` (same hue pipeline as orbit),
  side profile nose-right (`rotation.y = π/2`), one render, `toDataURL()`, ship disposed;
  renderer kept for the next cache miss.
- `null` fallback: the component renders a CSS triangle glyph tinted with the racer's color —
  identity degrades gracefully, layout identical.

## Live progress protocol

Cockpit → server (WS), extending the existing message — no new type:

```json
{ "t": "progress", "completed": 7, "frac": 0.42 }
```

- `frac` = matched-prefix length ÷ current prompt length, clamped 0–1. Sent on keystroke,
  **trailing-throttled to one message per 100 ms**; prompt-completion messages bypass the
  throttle and send immediately (as today).
- Server (`race.js`), only while `phase === 'running'`, racer known:
  - `m.completed === r.completed + 1` → advance (existing monotonic guard), `r.frac = 0`.
  - `m.completed === r.completed` → `r.frac = clamp01(Number(m.frac) || 0)`.
  - anything else → ignored (replay/out-of-order, as today).
  - `start()`/`reset()` zero `frac`. `snapshot()` ships include `frac`.
- `frac` is **display-only**: finishing, ranking, and `_allFinished` still key off `completed`
  alone. A hand-crafted `frac` can wiggle a sprite, never win a race.
- Load: 40 racers × 10 Hz = 400 msg/s inbound of ~40 bytes; broadcasts stay batched on the
  existing 50 ms tick. Negligible — **no server resize needed** (user offered; declined).

## Cockpit (`play.html` / `play.js`)

- Layout: `race-track` container fills the screen; typing dock (status line, prompt, input)
  pinned at bottom. The single-bar `#track`/`#me` mockup DOM is removed.
- `play.js` keeps: callsign-from-query, roster-denied message, reconnect loop, optimistic
  `completed` with server re-sync on reconnect/new-round (existing logic verbatim). Adds:
  `createRaceTrack(container, { me: callsign })`, `track.update(m)` on every race message, and
  the throttled `frac` sender wired to the existing `typedState()` matcher.

## Projector (`main.js`)

- `makeRace()` becomes `createRaceTrack(app)` — no `me`. The WebGL-capability branch and
  `race-fallback` import go away for the race path (orbit keeps its own fallback logic).
- `view.update(lastRaceShips)` changes to passing the whole race state (component needs
  `phase`/`total`, not just ships). `#race-hud` stays as-is.

## `/operator` console

- Static page served by the existing static handler; `app.js` adds route alias
  `/operator` → `/operator.html` (mirror of the `/play` alias). New third input in
  `vite.config.js`.
- UI: OPERATOR_KEY field (persisted `localStorage['shipit-operator-key']`), session picker
  (`cicd3`/`cicd4` — hardcoded to match `SESSIONS`), buttons **START RACE**, **RESET**,
  **VIEW: ORBIT/RACE**, wired to the three existing endpoints with
  `Authorization: Bearer <key>`; response status shown inline (`202 ✓` / `401 wrong key`).
- Live readout: read-only WS connection (no `join`) shows phase + joined-racer count from the
  broadcast race message. No server auth change — WS was always read-open; controls stay
  key-guarded HTTP POSTs.
- Ops note (accepted): key sits in operator's localStorage and travels plaintext over the
  board's HTTP — same classroom-grade posture as today's curl. Rotate the key per cohort.

## Testing (`node --test`, no new frameworks)

- `board/test/race.test.js` — extend: frac clamped, stored only while running, zeroed on
  completion/start/reset, ignored for unknown racers, absent `frac` defaults 0, never flips
  phase.
- `board/client/race-layout.test.js` — `progressOf` bounds, `laneOrder` stability, `ranks`
  finished-first ordering + ties.
- `board/test/server.test.js` — extend if it exercises WS progress: frac round-trips into the
  broadcast.
- Deleted files take their tests with them (`track.test.js`; `race-view`/`race-fallback` had
  none beyond track's).
- Sprite rendering and CSS sizing are visual — verified by hand against dev board (WebGL and
  no-WebGL paths), not unit-tested, per repo convention (props are pedagogy-first).

## Rollout

Board-only change — no learner-repo, workflow, or slide-contract impact (`report.sh` event
contract untouched; race WS message extended backward-compatibly: old clients ignore `frac`).
Ship as a normal board release: build, tag, GHCR publish, redeploy instructor EC2.
