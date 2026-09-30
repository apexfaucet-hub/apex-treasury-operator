'use strict';
// ACCOUNT LAYER readiness (2026-09-29): consumers may be connected only after N consecutive CLEAN cycles that the TIMER
// started. A hand-started cycle never counts, and any unclean scheduled cycle resets the count to zero. PURE.
function consecutiveCleanScheduled(history) {
  const h = history.filter((x) => x && x.trigger === 'timer');
  let n = 0; for (let i = h.length - 1; i >= 0 && h[i].clean === true; i--) n++;
  return n;
}
module.exports = { consecutiveCleanScheduled };
