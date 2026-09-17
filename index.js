// ============================================================
// Meta Ads Auto Monitor
// Every run: checks all active ads, applies stop rules, pauses matches
//
// Extra logic on top of the base stop rules:
//  - "2nd chance" duplicate: an ad that gets >=1 sale TODAY and still
//    hits the hard spend cap gets duplicated (identical copy) for one
//    extra shot. If that duplicate also hits the cap with a sale, it's
//    just paused normally — no further duplicating.
//  - Daily restart for "winning" ads: an ad with lifetime sales > 3 and
//    a lifetime average cost/sale < $3 that hits the hard cap is paused
//    and scheduled to restart automatically at 00:00 Algeria time. If
//    this pause-then-restart happens 3 days in a row, the ad is
//    permanently blacklisted (paused for good, never checked again).
// ============================================================

const axios = require('axios');
const { getActiveAds, getAdStats, pauseAd, duplicateAd } = require('./lib/meta');
const { loadState, saveState } = require('./lib/state');
const { algeriaDateString, previousDateString } = require('./lib/algeria-date');

// ---------- Config (comes from GitHub Secrets / workflow env) ----------
const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_IDS = (process.env.AD_ACCOUNT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SPEND_THRESHOLD = parseFloat(process.env.SPEND_THRESHOLD || '2'); // Rule 1: spend >= this AND sales <= MIN_SALES
const MIN_SALES = parseInt(process.env.MIN_SALES || '0', 10);
const HARD_SPEND_CAP = parseFloat(process.env.HARD_SPEND_CAP || '3.5'); // Rule 2: spend > this, regardless of sales

// "Winning ad" thresholds — lifetime stats, used to grant the daily-restart treatment
const WINNER_MIN_SALES = parseInt(process.env.WINNER_MIN_SALES || '3', 10); // "more than 3" -> sales > 3
const WINNER_MAX_AVG_COST = parseFloat(process.env.WINNER_MAX_AVG_COST || '3'); // avg cost/sale < 3
const WINNER_STREAK_LIMIT = parseInt(process.env.WINNER_STREAK_LIMIT || '3', 10); // 3 consecutive days -> blacklist

const DATE_PRESET = process.env.DATE_PRESET || 'today';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // optional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // optional

if (!TOKEN || AD_ACCOUNT_IDS.length === 0) {
  console.error('❌ Error: META_ACCESS_TOKEN and AD_ACCOUNT_IDS must be set in GitHub Secrets');
  process.exit(1);
}

// ---------- Optional Telegram notification ----------
async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return; // feature not configured, skip silently

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error(`⚠️ Failed to send Telegram report: ${err.message}`);
  }
}

// Telegram caps a single message at 4096 characters — split long reports into chunks
async function sendTelegramReport(lines) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const MAX_LEN = 3500; // safety margin below the 4096 hard limit
  let chunk = '';

  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX_LEN) {
      await sendTelegramMessage(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await sendTelegramMessage(chunk);
}

// ---------- Is this ad a proven "winner"? (lifetime stats) ----------
async function isWinningAd(adId) {
  const { spend, sales } = await getAdStats(TOKEN, adId, 'maximum');
  if (sales <= WINNER_MIN_SALES) return false;
  const avgCost = spend / sales;
  return avgCost < WINNER_MAX_AVG_COST;
}

// ---------- Handle an ad that just hit the hard spend cap ----------
async function handleHardCapHit(ad, todaySales, state, today) {
  // Already a 2nd-chance duplicate hitting the cap again? Just pause it, no more cloning.
  if (state.secondChanceDuplicates[ad.id]) {
    await pauseAd(TOKEN, ad.id);
    return { action: 'PAUSED', reason: 'plafond (2e chance déjà utilisée)' };
  }

  let winner = false;
  try {
    winner = await isWinningAd(ad.id);
  } catch (err) {
    console.error(`⚠️ Could not fetch lifetime stats for "${ad.name}": ${err.message}`);
  }

  if (winner) {
    await pauseAd(TOKEN, ad.id);

    const prev = state.winnerStreaks[ad.id];
    const streak = prev && prev.lastCapDate === previousDateString(today) ? prev.streak + 1 : 1;

    if (streak >= WINNER_STREAK_LIMIT) {
      state.blacklist[ad.id] = true;
      delete state.winnerStreaks[ad.id];
      return { action: 'BLACKLISTED', reason: `${streak} jours de suite au plafond — arrêtée définitivement` };
    }

    state.winnerStreaks[ad.id] = { streak, lastCapDate: today };
    state.pendingRestarts.push({ adId: ad.id, adName: ad.name });
    return {
      action: 'PAUSED (relance minuit)',
      reason: `annonce gagnante au plafond — jour ${streak}/${WINNER_STREAK_LIMIT}`,
    };
  }

  if (todaySales >= 1) {
    await pauseAd(TOKEN, ad.id);
    try {
      const newAdId = await duplicateAd(TOKEN, ad.id, ' (2e chance)');
      if (newAdId) {
        state.secondChanceDuplicates[newAdId] = true;
        return { action: 'PAUSED + DUPLIQUÉE', reason: `plafond avec vente(s) → nouvelle annonce ${newAdId}` };
      }
      return { action: 'PAUSED', reason: 'plafond avec vente(s) (duplication a échoué, pas d\'ID retourné)' };
    } catch (err) {
      console.error(`⚠️ Duplication failed for "${ad.name}": ${err.message}`);
      return { action: 'PAUSED', reason: `plafond avec vente(s) (duplication a échoué: ${err.message})` };
    }
  }

  await pauseAd(TOKEN, ad.id);
  return { action: 'PAUSED', reason: `hard spend cap (> $${HARD_SPEND_CAP})` };
}

// ---------- Main cycle ----------
async function runCycle() {
  const startTime = new Date().toISOString();
  const today = algeriaDateString();
  console.log(`\n===== Cycle started: ${startTime} =====`);

  const state = loadState();

  let checked = 0;
  let paused = 0;
  let skipped = 0;
  let ignoredBlacklisted = 0;
  const adReportLines = []; // one line per successfully-checked ad (paused or not)

  for (const accountId of AD_ACCOUNT_IDS) {
    console.log(`\n--- Account: ${accountId} ---`);

    let ads = [];
    try {
      ads = await getActiveAds(TOKEN, accountId);
    } catch (err) {
      console.error(`⚠️ Could not read ads for account ${accountId}: ${err.message}`);
      continue; // skip this account, keep going with the rest
    }

    console.log(`Active ads found: ${ads.length}`);

    for (const ad of ads) {
      // Permanently blacklisted ads are never touched or evaluated again
      if (state.blacklist[ad.id]) {
        ignoredBlacklisted++;
        continue;
      }

      checked++;
      try {
        const { spend, sales } = await getAdStats(TOKEN, ad.id, DATE_PRESET);

        const noSalesRuleHit = spend >= SPEND_THRESHOLD && sales <= MIN_SALES;
        const hardCapRuleHit = spend > HARD_SPEND_CAP;

        if (hardCapRuleHit) {
          const result = await handleHardCapHit(ad, sales, state, today);
          paused++;
          adReportLines.push(
            `🛑 <b>${ad.name}</b> — $${spend.toFixed(2)} | ${sales} sales | ${result.action} (${result.reason})`
          );
          console.log(
            `🛑 ${result.action}: "${ad.name}" | spend: $${spend.toFixed(2)} | sales: ${sales} | ${result.reason}`
          );
        } else if (noSalesRuleHit) {
          await pauseAd(TOKEN, ad.id);
          paused++;
          const reason = `no sales rule (>= $${SPEND_THRESHOLD} with <= ${MIN_SALES} sales)`;
          adReportLines.push(
            `🛑 <b>${ad.name}</b> — $${spend.toFixed(2)} | ${sales} sales | PAUSED (${reason})`
          );
          console.log(
            `🛑 PAUSED: "${ad.name}" | spend: $${spend.toFixed(2)} | sales: ${sales} | reason: ${reason}`
          );
        } else {
          adReportLines.push(
            `✅ ${ad.name} — $${spend.toFixed(2)} | ${sales} sales | running`
          );
          console.log(
            `✅ OK: "${ad.name}" | spend: $${spend.toFixed(2)} | sales: ${sales}`
          );
        }
      } catch (err) {
        // Important rule: any read error = skip the ad, never pause on bad/missing data
        skipped++;
        console.error(`⏭️ SKIPPED "${ad.name}" (read error): ${err.message}`);
      }
    }
  }

  saveState(state);

  console.log(`\n===== Cycle summary =====`);
  console.log(`Total ads checked: ${checked}`);
  console.log(`Paused: ${paused}`);
  console.log(`Skipped (read error): ${skipped}`);
  console.log(`Ignored (blacklisted): ${ignoredBlacklisted}`);
  console.log(`===== Cycle finished =====\n`);

  const summaryLines = [
    `<b>Meta Ads Auto Monitor</b> — ${startTime}`,
    `Checked: ${checked} | Paused: ${paused} | Skipped: ${skipped} | Blacklistées (ignorées): ${ignoredBlacklisted}`,
    '',
    ...adReportLines,
  ];
  await sendTelegramReport(summaryLines);
}

runCycle().catch(async (err) => {
  console.error('❌ Fatal script error:', err.message);
  await sendTelegramReport([`⚠️ Meta Ads Auto Monitor crashed: ${err.message}`]);
  process.exit(1);
});
