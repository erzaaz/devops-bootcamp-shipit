export function parse(raw) {
  try { const m = JSON.parse(raw); return (m && typeof m === 'object') ? m : null; }
  catch { return null; }
}
export const rosterMsg = (ships) => JSON.stringify({ t: 'roster', ships });
