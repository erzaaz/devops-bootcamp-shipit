# WPM as a ship speed statistic

**Date:** 2026-07-21
**Status:** Implemented on `feat/wpm-ship-speed-stat` (5 commits `e44ca86`..`1b5aea2`)
**Depends on:** the unified 2D race UI (`2026-07-20-unified-race-ui-design.md`)

## What

Show each racer's typing speed in **words per minute** as a ship statistic: live in the
learner's own cockpit, and broadcast onto the shared projector track so every ship carries its
WPM next to its position.

WPM is a display stat only. It does **not** move the ship — position stays driven by
`completed + frac` exactly as today. Speed is shown, not simulated.

## Why

The race already renders progress. WPM adds a personal, comparable number — "I'm typing 72,
they're at 61" — turning the shared track into a leaderboard of *how fast*, not just *how far*.
It reuses data the cockpit already has (keystroke timing) and rides the existing progress
messages, so it is cheap.

## Definitions

- **WPM** = cumulative pace, standard formula: a "word" is 5 characters.
  `wpm = round(((correctChars − charsAtStart) / 5) / ((now − startAt) / 60000))`.
- **correctChars** = Σ lengths of the prompts the racer has completed this session +
  `typedCount` of the current line. Only correct keystrokes land (strict typing), so gross WPM
  == net WPM; there is no error penalty to model.
- **The clock** runs from the race `go` transition (`phase` becomes `running`) to finish. On
  finish the value freezes (cockpit stops sending; server keeps the last value).

## Decisions (resolved in brainstorming)

1. **Scope:** cockpit **and** shared board. WPM is broadcast and rendered per ship on the track.
2. **Window:** cumulative pace from `go` (steady, honest race average), not a rolling window.
3. **Idle board behaviour:** **stale until next keystroke.** The board only hears WPM on
   `progress` messages, which fire on keystrokes/completions. A paused ship's board WPM holds at
   its last-sent value; the cockpit's own chip keeps ticking down locally. This keeps the server
   `Race` model pure — **no wall clock on the server**, no idle-rebroadcast timer.
4. **Cockpit readout position:** on the terminal bar (`#termbar`), terminal-HUD style, right of
   the title.

## Data flow

```
cockpit (play.js)                server (app.js + race.js)        track (race-track.js)
─────────────────                ─────────────────────────        ─────────────────────
compute wpm locally  ──progress──▶ race.report(cs, completed,      reads s.wpm from the
(startAt, charsAtStart)  {completed,   frac, wpm)                     race snapshot ship,
                          frac, wpm}   └ stores clamped int wpm       renders in meta
                                       └ snapshot() emits wpm
own chip: 250ms tick                   └ raceMsg spreads ...s
(local decay only)
```

## Components & changes

### `board/client/play.js` — cockpit (compute + send + own readout)

- On the `go` transition (already detected: `m.phase === 'running' && prevPhase !== 'running'`),
  stamp `startAt = Date.now()` and `charsAtStart = correctChars()`. This baseline makes a
  mid-race reload restart the clock cleanly instead of spiking (only chars typed *this session*
  count against *this session's* elapsed time).
- `correctChars()` = `prompts.slice(0, completed).reduce((n, p) => n + p.length, 0) + typedCount`.
- `currentWpm()` = the formula above; returns `null` (renders `—`) when `startAt` is unset or
  elapsed < ~1s (avoids a divide-by-near-zero spike on the first character).
- Piggyback `wpm: currentWpm() ?? 0` onto **both** existing `progress` sends: the throttled
  `fracSender` payload and the ENTER-completion payload in `onkeydown`. No new message type, no
  new throttle. The final completion send therefore carries the frozen final WPM.
- Own chip: a `#wpm` element in `#termbar`, updated in `render()` and on a light
  `setInterval(…, 250)` that runs only while `phase === 'running'` (so idle decay shows locally).
  Clear the interval on finish/idle.

### `board/client/play.html` — cockpit markup

- Add `<span id="wpm"></span>` inside `#termbar`, after `#termtitle`.

### `board/client/play.css` — cockpit styling

- Style `#wpm` as a right-aligned HUD readout on the terminal bar (monospace, dim label, bright
  number), consistent with the existing termbar/dock theme.

### `board/src/race.js` — Race model (store the stat)

- Racer state `{ completed, finishedAt, frac }` → add `wpm: 0`. Initialise in `join()` and reset
  to `0` in `start()`/`reset()`.
- `report(callsign, completed, frac, wpm)` gains a `wpm` param: store
  `r.wpm = Number.isFinite(wpm) ? Math.max(0, Math.round(wpm)) : r.wpm` (ignore junk, keep last).
  `progress()` is unchanged (it advances position; WPM is orthogonal).
- `snapshot()` ship objects include `wpm`.

### `board/src/app.js` — WS message handling

- In the `m.t === 'progress'` branch, pass `m.wpm` through:
  `race.report(ws.callsign, m.completed, m.frac, m.wpm)`.

### `board/src/messages.js` — race broadcast

- No change needed: `raceMsg` already does `{ ...s, color, shipModel }`, so `wpm` flows through
  automatically. (Note it in the comment.)

### `board/client/race-track.js` — track meta

- In `update()`, extend the meta text:
  - running: `` `${wpmText}${((completed)+(frac)).toFixed(1)}/${total}` `` →
    render as e.g. `72wpm · 5.0/12` (omit the `72wpm ·` prefix when `wpm` falsy/0).
  - finished: `` `✦ #${rank}${wpm ? ` · ${wpm}wpm` : ''}` ``.
- `wpm` read from `s.wpm` on the snapshot ship (undefined for pre-WPM ships → treated as absent).

## Testing

Follow the repo's `node --test` convention (dev-time unit tests; no vitest/playwright).

- **`board/src/race.test.js`** (extend): `report` with a `wpm` arg stores a rounded, clamped int;
  junk/NaN wpm keeps the previous value; `snapshot()` exposes `wpm`; `start()`/`reset()` zero it.
- **`board/client/`** — a small pure helper for the WPM formula is the testable seam. Extract
  `computeWpm({ correctChars, charsAtStart, startAt, now })` (pure) into a tiny module (or
  alongside `typing.js`) and unit-test it: zero elapsed → `null`; baseline subtraction; the 5-char
  word rule; rounding. `play.js` DOM wiring stays untested (consistent with existing client tests
  that only cover pure helpers).

## Out of scope (YAGNI)

- WPM does not affect ship position or race outcome.
- No rolling-window / instantaneous WPM.
- No persistence of WPM beyond the current session snapshot.
- No accuracy metric (strict typing makes it always 100%).
- No historical/leaderboard storage across rounds.

## Contract note

The race WebSocket protocol (`join`/`progress`/`race`) is an **internal** board system, **not**
the PINNED pipeline↔board `/api/event` HTTP contract in `CLAUDE.md`. Adding `wpm` to `progress`
and to the `race` snapshot touches nothing the slides quote. No CLAUDE.md pinned-contract change.
