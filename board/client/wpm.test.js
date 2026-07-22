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
