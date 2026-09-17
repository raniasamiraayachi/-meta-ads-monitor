// ============================================================
// Tiny persistence layer. GitHub Actions containers are stateless
// between runs, so we keep a state.json file at the repo root and
// let the workflow commit it back after every run.
// ============================================================

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      // adId -> true : permanently ignored, never evaluated again
      blacklist: parsed.blacklist || {},
      // adId -> true : this ad IS a "2nd chance" duplicate, so it never gets duplicated again
      secondChanceDuplicates: parsed.secondChanceDuplicates || {},
      // adId -> { streak, lastCapDate } : consecutive-day hard-cap streak for "winning" ads
      winnerStreaks: parsed.winnerStreaks || {},
      // [{ adId, adName }] : winning ads paused today, to be reactivated at next midnight
      pendingRestarts: parsed.pendingRestarts || [],
    };
  } catch (err) {
    // No state file yet (first run) or it's corrupted — start fresh
    return { blacklist: {}, secondChanceDuplicates: {}, winnerStreaks: {}, pendingRestarts: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

module.exports = { loadState, saveState, STATE_PATH };
