// ============================================================
// Meta Ads Winner Restart
// Runs once a day at 00:00 Algeria time (see the workflow's cron).
// Reactivates ads that were paused at the hard spend cap while being
// a "winning" ad (see index.js) — giving them a fresh day. If an ad
// hits the cap 3 days in a row, index.js blacklists it and it will
// never show up in this list again.
// ============================================================

const axios = require('axios');
const { activateAd } = require('./lib/meta');
const { loadState, saveState } = require('./lib/state');

const TOKEN = process.env.META_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // optional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // optional

if (!TOKEN) {
  console.error('❌ Error: META_ACCESS_TOKEN must be set in GitHub Secrets');
  process.exit(1);
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
  } catch (err) {
    console.error(`⚠️ Failed to send Telegram report: ${err.message}`);
  }
}

async function run() {
  const state = loadState();
  const toRestart = state.pendingRestarts || [];

  console.log(`\n===== Winner restart — ${toRestart.length} ad(s) to reactivate =====`);

  const lines = ['<b>🌙 Relance de minuit — annonces gagnantes</b>', ''];
  let restarted = 0;

  for (const entry of toRestart) {
    try {
      await activateAd(TOKEN, entry.adId);
      restarted++;
      lines.push(`▶️ <b>${entry.adName}</b> relancée pour une nouvelle journée`);
      console.log(`▶️ Restarted: "${entry.adName}" (${entry.adId})`);
    } catch (err) {
      lines.push(`⚠️ Échec relance <b>${entry.adName}</b>: ${err.message}`);
      console.error(`⚠️ Failed to restart "${entry.adName}": ${err.message}`);
    }
  }

  // Clear the queue regardless — winnerStreaks (in index.js) keeps the day-count history
  state.pendingRestarts = [];
  saveState(state);

  if (restarted === 0) {
    lines.push("Aucune annonce à relancer aujourd'hui.");
  }

  await sendTelegramMessage(lines.join('\n'));
  console.log(`===== Winner restart finished: ${restarted} restarted =====\n`);
}

run().catch(async (err) => {
  console.error('❌ Fatal script error:', err.message);
  await sendTelegramMessage(`⚠️ Meta Ads Winner Restart crashed: ${err.message}`);
  process.exit(1);
});
