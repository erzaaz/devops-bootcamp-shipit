import './play.css';
import { typedState } from './typing.js';
import { createRaceTrack } from './race-track.js';

const params = new URLSearchParams(location.search);
const callsign = (params.get('callsign') || '').toLowerCase();
const statusEl = document.getElementById('status');
const promptEl = document.getElementById('prompt');
const entry = document.getElementById('entry');
const track = createRaceTrack(document.getElementById('field'), { me: callsign });

let prompts = [];
let phase = 'idle';
let completed = 0;  // my confirmed position (optimistic; server is authoritative)
let synced = false; // true once we've trusted the server's position after (re)connect
let prevPhase = 'idle';

function render() {
  const target = prompts[completed] || '';
  promptEl.textContent = target;
  if (phase === 'running' && completed < prompts.length) {
    const { matched } = typedState(target, entry.value);
    promptEl.dataset.matched = String(matched);
    entry.disabled = false;
  } else {
    entry.disabled = true;
  }
  statusEl.textContent =
    phase === 'running' ? `RACING — ${completed}/${prompts.length}`
    : phase === 'finished' ? 'FINISHED ✦'
    : 'waiting for race…';
}

// Trailing throttle: at most one frac report per 100ms. Completions bypass
// this and send immediately in the input handler.
function fracSender(ws) {
  let timer = null, latest = 0;
  const send = (frac) => {
    latest = frac;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (ws.readyState === WebSocket.OPEN && phase === 'running') {
        ws.send(JSON.stringify({ t: 'progress', completed, frac: latest }));
      }
    }, 100);
  };
  send.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } latest = 0; };
  return send;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  const sendFrac = fracSender(ws);
  ws.onopen = () => { synced = false; statusEl.textContent = 'joining…'; ws.send(JSON.stringify({ t: 'join', callsign })); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'denied') { statusEl.textContent = 'Ship not found — run your pipeline first.'; entry.disabled = true; return; }
    if (m.t === 'race') {
      prompts = m.prompts || [];
      phase = m.phase;
      const mine = (m.ships || []).find((s) => s.callsign === callsign);
      const serverCompleted = mine ? mine.completed : 0;
      if (!synced) { completed = serverCompleted; synced = true; }             // (re)connect/reload: trust the server's position
      else if (m.phase === 'running' && prevPhase !== 'running') completed = serverCompleted; // new round: server reset us to 0
      // during a running round, keep the local optimistic `completed`; the server silently rejects bad progress
      prevPhase = m.phase;
      track.update({ phase: m.phase, total: m.total, ships: m.ships || [] });
      render();
    }
  };
  entry.oninput = () => {
    const target = prompts[completed] || '';
    const { matched, done } = typedState(target, entry.value);
    promptEl.dataset.matched = String(matched);
    if (done && phase === 'running') {
      sendFrac.cancel();
      completed += 1;
      entry.value = '';
      ws.send(JSON.stringify({ t: 'progress', completed }));
      render();
    } else if (phase === 'running' && target.length > 0) {
      sendFrac(matched / target.length);
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected — reconnecting…'; setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}

if (!callsign) { statusEl.textContent = 'No callsign — open this from your ship\'s READY button.'; entry.disabled = true; }
else connect();
