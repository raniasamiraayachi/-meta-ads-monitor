// ============================================================
// Meta Ads Auto Monitor
// Every run: checks all active ads, applies stop rules, pauses matches
// ============================================================

const axios = require('axios');

// ---------- Config (comes from GitHub Secrets) ----------
const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_IDS = (process.env.AD_ACCOUNT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SPEND_THRESHOLD = parseFloat(process.env.SPEND_THRESHOLD || '2'); // Rule 1: spend >= this AND sales <= MIN_SALES
const MIN_SALES = parseInt(process.env.MIN_SALES || '0', 10);
const HARD_SPEND_CAP = parseFloat(process.env.HARD_SPEND_CAP || '3.5'); // Rule 2: spend > this, regardless of sales

const DATE_PRESET = process.env.DATE_PRESET || 'today';
const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // optional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // optional

if (!TOKEN || AD_ACCOUNT_IDS.length === 0) {
  console.error('❌ Error: META_ACCESS_TOKEN and AD_ACCOUNT_IDS must be set in GitHub Secrets');
  process.exit(1);
}

// ---------- Fetch active ads for one account ----------
async function getActiveAds(accountId) {
  const url = `${BASE_URL}/${accountId}/ads`;
  const ads = [];
  let nextUrl = url;
  let params = {
    access_token: TOKEN,
    fields: 'id,name,effective_status',
    filtering: JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
    ]),
    limit: 200,
  };

  while (nextUrl) {
    const res = await axios.get(nextUrl, { params });
    ads.push(...res.data.data);
    nextUrl = res.data.paging && res.data.paging.next ? res.data.paging.next : null;
    params = undefined; // the "next" link already contains all needed params
  }

  return ads;
}

// ---------- Fetch spend + sales for one ad ----------
async function getAdStats(adId) {
  const url = `${BASE_URL}/${adId}/insights`;
  const params = {
    access_token: TOKEN,
    fields: 'spend,actions',
    date_preset: DATE_PRESET,
  };

  const res = await axios.get(url, { params });
  const row = res.data.data && res.data.data[0];

  if (!row) {
    // No data yet today = spend 0, sales 0
    return { spend: 0, sales: 0 };
  }

  const spend = parseFloat(row.spend || 0);

  let sales = 0;
  if (Array.isArray(row.actions)) {
    const purchaseAction = row.actions.find(
      (a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase'
    );
    if (purchaseAction) sales = parseInt(purchaseAction.value, 10) || 0;
  }

  return { spend, sales };
}

// ---------- Pause an ad ----------
async function pauseAd(adId) {
  const url = `${BASE_URL}/${adId}`;
  await axios.post(url, null, {
    params: { status: 'PAUSED', access_token: TOKEN },
  });
}

// ---------- Optional Telegram notification ----------
async function sendTelegramReport(message) {
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

// ---------- Main cycle ----------
async function runCycle() {
  const startTime = new Date().toISOString();
  console.log(`\n===== Cycle started: ${startTime} =====`);

  let checked = 0;
  let paused = 0;
  let skipped = 0;
  const pausedAdsList = [];

  for (const accountId of AD_ACCOUNT_IDS) {
    console.log(`\n--- Account: ${accountId} ---`);

    let ads = [];
    try {
      ads = await getActiveAds(accountId);
    } catch (err) {
      console.error(`⚠️ Could not read ads for account ${accountId}: ${err.message}`);
      continue; // skip this account, keep going with the rest
    }

    console.log(`Active ads found: ${ads.length}`);

    for (const ad of ads) {
      checked++;
      try {
        const { spend, sales } = await getAdStats(ad.id);

        const noSalesRuleHit = spend >= SPEND_THRESHOLD && sales <= MIN_SALES;
        const hardCapRuleHit = spend > HARD_SPEND_CAP;

        if (noSalesRuleHit || hardCapRuleHit) {
          await pauseAd(ad.id);
          paused++;
          const reason = hardCapRuleHit
            ? `hard spend cap (> $${HARD_SPEND_CAP})`
            : `no sales rule (>= $${SPEND_THRESHOLD} with <= ${MIN_SALES} sales)`;
          pausedAdsList.push(`• ${ad.name} — spend $${spend.toFixed(2)}, sales ${sales} (${reason})`);
          console.log(
            `🛑 PAUSED: "${ad.name}" | spend: $${spend.toFixed(2)} | sales: ${sales} | reason: ${reason}`
          );
        } else {
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

  console.log(`\n===== Cycle summary =====`);
  console.log(`Total ads checked: ${checked}`);
  console.log(`Paused: ${paused}`);
  console.log(`Skipped (read error): ${skipped}`);
  console.log(`===== Cycle finished =====\n`);

  const summaryLines = [
    `<b>Meta Ads Auto Monitor</b>`,
    `Checked: ${checked} | Paused: ${paused} | Skipped: ${skipped}`,
  ];
  if (pausedAdsList.length > 0) {
    summaryLines.push('', '<b>Paused ads:</b>', ...pausedAdsList);
  }
  await sendTelegramReport(summaryLines.join('\n'));
}

runCycle().catch(async (err) => {
  console.error('❌ Fatal script error:', err.message);
  await sendTelegramReport(`⚠️ Meta Ads Auto Monitor crashed: ${err.message}`);
  process.exit(1);
});
