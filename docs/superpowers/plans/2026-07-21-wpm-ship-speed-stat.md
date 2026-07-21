# WPM Ship Speed Stat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each racer's typing speed in words-per-minute as a ship statistic — live in the cockpit and broadcast onto the shared projector track.

**Architecture:** WPM is a cumulative pace computed in the cockpit (the server `Race` model stays clock-free and pure). The cockpit piggybacks a `wpm` field on the `progress` WebSocket messages it already sends. The `Race` model stores it, `snapshot()` emits it, `raceMsg` spreads it to every spectator, and the track renders it in each ship's meta line. Display-only — WPM never moves the ship.

**Tech Stack:** Node 20+ ESM, `ws` WebSocket server, `node --test` (no vitest/playwright), Vite-bundled vanilla-JS client.

## Global Constraints

- Node 20, ESM, fail loud, no CDN. (`CLAUDE.md` Conventions.)
- Tests: `node --test` only. Server tests live in `board/test/*.test.js`; client **pure-helper** tests colocate as `board/client/*.test.js`. DOM wiring (play.js, race-track.js) is not unit-tested — consistent with existing client tests, which cover only pure helpers.
- WPM is **display-only**: it must not change `completed`, `frac`, or race outcome.
- Server `Race` model stays pure and clock-free — **no `Date.now()` / wall clock in `board/src/`**. All timing is cockpit-local.
- The race WS protocol is internal, **not** the PINNED `/api/event` HTTP contract — no `CLAUDE.md` change.
- Run all test commands from the `board/` directory.

---

### Task 1: Pure WPM formula helper

The one testable seam on the client: a pure function that turns typed-char counts + timestamps into an integer WPM. `play.js` will call it; tests cover it directly.

**Files:**
- Create: `board/client/wpm.js`
- Test: `board/client/wpm.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeWpm({ correctChars, charsAtStart, startAt, now }) -> number | null`. Returns `null` when `startAt` is null/undefined or `now - startAt < 1000` (too little elapsed to be meaningful). Otherwise returns `max(0, round( ((correctChars - charsAtStart) / 5) / ((now - startAt) / 60000) ))`. A "word" is 5 characters.

- [ ] **Step 1: Write the failing test**

Create `board/client/wpm.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWpm } from './wpm.js';

test('returns null before the clock starts', () => {
  assert.equal(computeWpm({ correctChars: 40, charsAtStart: 0, startAt: null, now: 60000 }), null);
});

test('returns null when too little time has elapsed', () => {
  // 999ms < 1s guard — avoids a divide-by-near-zero spike on the first char.
  assert.equal(computeWpm({ correctChars: 5, charsAtStart: 0, startAt: 0, now: 999 }), null);
});

test('computes cumulative WPM with the 5-char word rule', () => {
  // 300 chars = 60 words in 60s = 60 WPM.
  assert.equal(computeWpm({ correctChars: 300, charsAtStart: 0, startAt: 0, now: 60000 }), 60);
  // 350 chars in 58s: (350/5)/(58/60) = 72.4 -> 72
  assert.equal(computeWpm({ correctChars: 350, charsAtStart: 0, startAt: 0, now: 58000 }), 72);
});

test('subtracts the session baseline (reload safety)', () => {
  // 40 of 100 chars were already done before this session's clock started:
  // only 60 chars count against 30s -> (60/5)/(30/60) = 24 WPM.
  assert.equal(computeWpm({ correctChars: 100, charsAtStart: 40, startAt: 0, now: 30000 }), 24);
});

test('never returns negative', () => {
  assert.equal(computeWpm({ correctChars: 0, charsAtStart: 10, startAt: 0, now: 60000 }), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test client/wpm.test.js`
Expected: FAIL — `Cannot find module './wpm.js'` / `computeWpm is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `board/client/wpm.js`:

```javascript
// board/client/wpm.js
// Pure cumulative-WPM math for the cockpit. A "word" is 5 characters (standard
// WPM). The clock is cockpit-local — the server Race model stays clock-free.
// charsAtStart is the baseline captured when the local clock started, so a
// mid-race reload counts only chars typed THIS session (no spike).
export function computeWpm({ correctChars, charsAtStart, startAt, now }) {
  if (startAt == null) return null;
  const ms = now - startAt;
  if (ms < 1000) return null; // too little elapsed to be meaningful
  const words = (correctChars - charsAtStart) / 5;
  const wpm = words / (ms / 60000);
  return Math.max(0, Math.round(wpm));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd board && node --test client/wpm.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add board/client/wpm.js board/client/wpm.test.js
git commit -m "feat(board): pure computeWpm helper (cumulative pace, 5-char word)"
```

---

### Task 2: Race model stores wpm + server pass-through

Add a `wpm` stat to each racer, accept it on `report()`, emit it from `snapshot()`, and thread `m.wpm` through the WS handler. `messages.raceMsg` already spreads `...s`, so no code change there — only a clarifying comment.

**Files:**
- Modify: `board/src/race.js`
- Modify: `board/src/app.js:117-119` (the `m.t === 'progress'` branch)
- Modify: `board/src/messages.js` (comment only)
- Test: `board/test/race.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1 (server is independent).
- Produces: `Race#report(callsign, completed, frac, wpm)` — the new 4th param stores a clamped non-negative integer WPM (`r.wpm`); junk/NaN keeps the previous value. `snapshot()` ships now include `wpm`. Racer state shape is `{ completed, finishedAt, frac, wpm }`.

- [ ] **Step 1: Write the failing tests**

Append to `board/test/race.test.js`:

```javascript
test('report stores a clamped, rounded integer wpm', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  r.report('octocat', 0, 0.5, 71.6);            // same-index report carries wpm
  assert.equal(r.snapshot().ships[0].wpm, 72);  // rounded
  r.report('octocat', 0, 0.5, -5);
  assert.equal(r.snapshot().ships[0].wpm, 0);   // clamped to >= 0
});

test('report ignores junk wpm and keeps the last good value', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  r.report('octocat', 0, 0.5, 60);
  r.report('octocat', 0, 0.5, NaN);
  assert.equal(r.snapshot().ships[0].wpm, 60);
  r.report('octocat', 0, 0.5, undefined);
  assert.equal(r.snapshot().ships[0].wpm, 60);
});

test('join, start and reset zero the wpm stat', () => {
  const r = new Race({ total: 3 });
  assert.equal(r.join('octocat').wpm, 0);
  r.start(prompts(3));
  r.report('octocat', 0, 0.5, 88);
  assert.equal(r.snapshot().ships[0].wpm, 88);
  r.start(prompts(3));                            // new round
  assert.equal(r.snapshot().ships[0].wpm, 0);
  r.report('octocat', 0, 0.5, 88);
  r.reset();
  assert.equal(r.snapshot().ships[0].wpm, 0);
});

test('a completion still advances position regardless of wpm', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  assert.equal(r.report('octocat', 1, 0, 40).completed, 1); // wpm does not block advance
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd board && node --test test/race.test.js`
Expected: FAIL — new tests fail (`wpm` is `undefined`); existing tests still pass.

- [ ] **Step 3: Implement in `board/src/race.js`**

In `join()`, add `wpm: 0` to the initial racer object:

```javascript
  join(callsign) {
    if (!this.racers.has(callsign)) this.racers.set(callsign, { completed: 0, finishedAt: null, frac: 0, wpm: 0 });
    return this.racers.get(callsign);
  }
```

In `start()`, zero `wpm` alongside the other fields:

```javascript
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; r.frac = 0; r.wpm = 0; }
```

In `report()`, add the `wpm` param and store it (before the existing dispatch so it applies to both same-index and advance reports):

```javascript
  report(callsign, completed, frac, wpm) {
    if (this.phase !== 'running') return null;
    const r = this.racers.get(callsign);
    if (!r) return null;
    if (Number.isFinite(wpm)) r.wpm = Math.max(0, Math.round(wpm));
    if (completed === r.completed + 1) return this.progress(callsign, completed);
    if (completed === r.completed) r.frac = clamp01(frac);
    return r;
  }
```

In `reset()`, zero `wpm`:

```javascript
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; r.frac = 0; r.wpm = 0; }
```

In `snapshot()`, include `wpm`:

```javascript
    const ships = [...this.racers.entries()].map(([callsign, r]) => ({
      callsign, completed: r.completed, finishedAt: r.finishedAt, frac: r.frac, wpm: r.wpm,
    }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd board && node --test test/race.test.js`
Expected: PASS — all tests (old + 4 new) pass.

- [ ] **Step 5: Thread `m.wpm` through the WS handler**

In `board/src/app.js`, the `m.t === 'progress'` branch (around line 117-119) — pass `m.wpm`:

```javascript
      } else if (m.t === 'progress' && ws.callsign && Number.isInteger(m.completed)) {
        race.report(ws.callsign, m.completed, m.frac, m.wpm);
        raceDirty = true;
      }
```

- [ ] **Step 6: Comment `messages.js` (no logic change)**

In `board/src/messages.js`, update the enrich comment above `raceMsg` so a future reader knows `wpm` rides the spread:

```javascript
// Enrich race positions with each ship's roster appearance (color/shipModel).
// Position fields (completed/frac/finishedAt) and the wpm stat ride the ...s spread.
```

- [ ] **Step 7: Run the full board suite**

Run: `cd board && node --test`
Expected: PASS — every board test passes (race + server + others).

- [ ] **Step 8: Commit**

```bash
git add board/src/race.js board/src/app.js board/src/messages.js board/test/race.test.js
git commit -m "feat(board): Race stores per-ship wpm stat, threaded through progress + snapshot"
```

---

### Task 3: Cockpit computes, sends, and displays own WPM

Wire the pure helper into `play.js`: stamp the clock on the `go` transition, compute WPM, piggyback it on both `progress` sends, and show a live-ticking readout on the terminal bar.

**Files:**
- Modify: `board/client/play.js`
- Modify: `board/client/play.html` (add `#wpm` to `#termbar`)
- Modify: `board/client/play.css` (style `#wpm`)

**Interfaces:**
- Consumes: `computeWpm(...)` from Task 1; the `wpm` field on `progress` messages consumed by Task 2's server.
- Produces: nothing consumed by later tasks (Task 4 reads `s.wpm` from the server snapshot, not from here).

- [ ] **Step 1: Add the terminal-bar readout element**

In `board/client/play.html`, add a `#wpm` span at the end of `#termbar` (after `#termtitle`):

```html
          <div id="termbar">
            <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
            <span id="termtitle">shipit — cockpit</span>
            <span id="wpm"></span>
          </div>
```

- [ ] **Step 2: Style the readout**

In `board/client/play.css`, after the `#termtitle` rule (line ~24), add:

```css
#wpm { margin-left: auto; color: #22d3ee; font-size: 0.75rem; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; min-width: 4.5ch; text-align: right; }
#wpm:empty { visibility: hidden; }
```

`margin-left: auto` pushes it to the far right of the flex termbar; `tabular-nums` stops the number jittering as digits change.

- [ ] **Step 3: Import the helper and add clock state**

In `board/client/play.js`, add to the imports at the top:

```javascript
import { computeWpm } from './wpm.js';
```

Add module-level state near the other `let` declarations (after `let currentTarget = null;`):

```javascript
let startAt = null;       // cockpit-local clock; stamped on the go transition
let charsAtStart = 0;     // baseline: chars already done when the clock started (reload-safe)
let wpmTimer = null;      // ticks the own readout while running (idle decay is local-only)
const wpmEl = document.getElementById('wpm');
```

- [ ] **Step 4: Add correctChars + wpm helpers and the readout tick**

In `board/client/play.js`, add these helpers (near `target`/`lineDone`, after line ~30):

```javascript
// Total correct characters typed this session: every completed prompt's full
// length plus the current line's strict cursor. Wrong keys never landed.
const correctChars = () => prompts.slice(0, completed).reduce((n, p) => n + p.length, 0) + typedCount;
const myWpm = () => computeWpm({ correctChars: correctChars(), charsAtStart, startAt, now: Date.now() });

function renderWpm() {
  const w = myWpm();
  wpmEl.textContent = w == null ? '' : `${w} WPM`;
}
function startWpmClock() {
  startAt = Date.now();
  charsAtStart = correctChars();
  clearInterval(wpmTimer);
  wpmTimer = setInterval(renderWpm, 250); // local decay while paused; board updates on keystroke
}
function stopWpmClock() {
  clearInterval(wpmTimer); wpmTimer = null;
}
```

- [ ] **Step 5: Stamp the clock on the go transition**

In `board/client/play.js`, in `ws.onmessage`'s `m.t === 'race'` branch, where the go SFX fires (line ~96), start/stop the clock alongside it:

```javascript
      if (m.phase === 'running' && prevPhase !== 'running') { sfx.go(); startWpmClock(); }
      if (m.phase !== 'running') stopWpmClock();
```

- [ ] **Step 6: Piggyback wpm on the throttled frac send**

In `board/client/play.js`, in `fracSender`, add `wpm` to the sent payload:

```javascript
      if (ws.readyState === WebSocket.OPEN && phase === 'running') {
        ws.send(JSON.stringify({ t: 'progress', completed, frac: latest, wpm: myWpm() ?? 0 }));
      }
```

- [ ] **Step 7: Piggyback wpm on the ENTER-completion send**

In `board/client/play.js`, in `entry.onkeydown`, the completion branch (line ~134) — add `wpm` so the final completion carries the frozen final value:

```javascript
      ws.send(JSON.stringify({ t: 'progress', completed, wpm: myWpm() ?? 0 }));
```

- [ ] **Step 8: Keep the readout fresh on every render**

In `board/client/play.js`, at the end of `render()` (after the `statusEl.textContent = …` block), add:

```javascript
  renderWpm();
```

- [ ] **Step 9: Manual verification (two cockpits + projector)**

Run: `cd board && npm run dev`
Then, in a browser:
1. Open the operator console (`/operator`), add two roster ships (e.g. `octocat`, `mona`), and start a race.
2. Open `/play?callsign=octocat` and `/play?callsign=mona` in two tabs; open `/` (projector) in a third.
3. Type in each cockpit. Verify:
   - Each cockpit's terminal bar shows a live `NN WPM` that rises as you type and drifts down when you pause.
   - The readout is blank for the first ~1s (the guard), then appears.
   - Reloading a cockpit mid-race does **not** spike its WPM (baseline resets; it starts fresh).

Expected: WPM readout behaves as described; ship position is unchanged by WPM.

- [ ] **Step 10: Commit**

```bash
git add board/client/play.js board/client/play.html board/client/play.css
git commit -m "feat(board): cockpit computes + sends WPM, live readout on the terminal bar"
```

---

### Task 4: Render WPM on the shared track meta

Show each ship's `wpm` in the track meta line, on both the projector and the cockpit's own track view.

**Files:**
- Modify: `board/client/race-track.js:112-114` (the `r.meta.textContent` assignment in `update()`)

**Interfaces:**
- Consumes: `s.wpm` from the race snapshot ship (produced by Task 2). Undefined/0 for pre-WPM ships → the prefix/suffix is omitted.
- Produces: nothing.

- [ ] **Step 1: Extend the meta text**

In `board/client/race-track.js`, in `update()`, replace the meta assignment (lines ~112-114):

```javascript
      const wpm = Math.round(s.wpm || 0);
      r.meta.textContent = s.finishedAt != null
        ? `✦ #${rk.get(s.callsign)}${wpm ? ` · ${wpm}wpm` : ''}`
        : `${wpm ? `${wpm}wpm · ` : ''}${((s.completed || 0) + (s.frac || 0)).toFixed(1)}/${total}`;
```

- [ ] **Step 2: Confirm the existing suite still passes**

Run: `cd board && node --test`
Expected: PASS — no test covers `race-track.js` (DOM), and nothing else regresses.

- [ ] **Step 3: Manual verification**

Run: `cd board && npm run dev` (or reuse the running instance).
With a race in progress across two cockpits + the projector:
1. On the projector track, verify each moving ship's meta reads e.g. `72wpm · 5.0/12`.
2. Let a ship finish; verify its meta reads e.g. `✦ #1 · 72wpm`.
3. Confirm a ship that has not typed yet (wpm 0) shows just `0.0/12` (no `0wpm ·` prefix).

Expected: WPM appears in meta for both running and finished ships, omitted when zero.

- [ ] **Step 4: Commit**

```bash
git add board/client/race-track.js
git commit -m "feat(board): render per-ship WPM in the shared track meta"
```

---

## Self-Review

**Spec coverage:**
- Formula (cumulative, 5-char word, baseline, <1s guard) → Task 1 ✓
- Transport (piggyback on both progress sends, no new message) → Task 3 Steps 6-7 ✓
- Server stores wpm (join/start/reset zero, report clamps int, snapshot emits) → Task 2 ✓
- `app.js` threads `m.wpm`, `messages.js` comment → Task 2 Steps 5-6 ✓
- Board/track meta (running + finished formats, omit when 0) → Task 4 ✓
- Cockpit own readout on `#termbar`, 250ms tick, local idle decay → Task 3 ✓
- Idle board = stale-until-keystroke (server pure, no clock) → guaranteed by design: server never computes wpm, only stores what cockpits send ✓
- Reload safety (baseline) → Task 1 test + Task 3 Step 4/9 ✓
- Display-only, no position effect → Task 2 test "completion still advances regardless of wpm" + Task 4 leaves position math untouched ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `computeWpm({ correctChars, charsAtStart, startAt, now })` — same shape in Task 1 impl, Task 1 tests, and Task 3 `myWpm()`. `report(callsign, completed, frac, wpm)` — same in Task 2 impl, Task 2 tests, and Task 3's `{ t:'progress', ..., wpm }` payload + Task 2 Step 5 `app.js` call. Racer state `{ completed, finishedAt, frac, wpm }` consistent across join/start/reset/snapshot. ✓
