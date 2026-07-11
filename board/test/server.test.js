import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';

const post = (port, body, headers = {}) =>
  fetch(`http://localhost:${port}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const openClient = (port) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.on('open', () => resolve(ws));
});
const nextMsg = (ws, pred) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('timeout')), 2000);
  const on = (data) => { const m = JSON.parse(data.toString()); if (!pred || pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
  ws.on('message', on);
});

const ev = { callsign: 'octocat', stage: 'build', status: 'passed', color: '#22d3ee' };

test('POST event (open mode) appears in the ws roster', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    const spectator = await openClient(port);
    await nextMsg(spectator, (m) => m.t === 'roster');       // initial snapshot
    assert.equal((await post(port, ev)).status, 202);
    const roster = await nextMsg(spectator, (m) => m.t === 'roster' && m.ships.some((s) => s.callsign === 'octocat'));
    const ship = roster.ships.find((s) => s.callsign === 'octocat');
    assert.equal(ship.stage, 'build');
    assert.equal(ship.status, 'passed');
    spectator.close();
  } finally { await app.close(); }
});

test('latest event wins per callsign', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    await post(port, { ...ev, stage: 'pad', status: 'running' });
    await post(port, { ...ev, stage: 'liftoff', status: 'shipped' });
    const spectator = await openClient(port);
    const roster = await nextMsg(spectator, (m) => m.t === 'roster' && m.ships.some((s) => s.callsign === 'octocat'));
    const mine = roster.ships.filter((s) => s.callsign === 'octocat');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].stage, 'liftoff');
    spectator.close();
  } finally { await app.close(); }
});

test('enforcing mode: 401 without/with wrong token, 202 with right token', async () => {
  const app = createServer({ port: 0, token: 'sooper-secret' });
  const port = app.port;
  try {
    assert.equal((await post(port, ev)).status, 401);
    assert.equal((await post(port, ev, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(port, ev, { authorization: 'Bearer sooper-secret' })).status, 202);
  } finally { await app.close(); }
});

test('malformed / invalid event → 400', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    assert.equal((await post(port, 'not json')).status, 400);
    assert.equal((await post(port, { callsign: 'x', stage: 'nope', status: 'passed' })).status, 400);
  } finally { await app.close(); }
});
