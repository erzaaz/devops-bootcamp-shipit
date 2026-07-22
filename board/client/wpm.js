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
