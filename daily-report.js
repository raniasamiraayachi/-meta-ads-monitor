// ============================================================
// Meta Ads Daily Report — full summary of YESTERDAY's activity
// Runs once a day (e.g. 10:00 Algeria time) via a separate workflow
// Sends a full campaign > ad breakdown to Telegram
// ============================================================

const axios = require('axios');

// ---------- Config (comes from GitHub Secrets) ----------
const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_IDS = (process.env.AD_ACCOUNT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || AD_ACCOUNT_IDS.length === 0) {
  console.error('❌ Error: META_ACCESS_TOKEN and AD_ACCOUNT_IDS must be set in GitHub Secrets');
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set for the daily report');
  process.exit(1);
}

// ---------- Fetch yesterday's insights at ad level ----------
async function getYesterdayInsights(accountId) {
  const url = `${BASE_URL}/${accountId}/insights`;
  const rows = [];
  let nextUrl = url;
  let params = {
    access_token: TOKEN,
    level: 'ad',
    date_preset: 'yesterday',
    fields: [
      'campaign_name',
      'adset_name',
      'ad_name',
      'spend',
      'reach',
      'impressions',
      'clicks',
      'actions',
      'action_values',
    ].join(','),
    limit: 200,
  };

  while (nextUrl) {
    const res = await axios.get(nextUrl, { params });
    rows.push(...res.data.data);
    nextUrl = res.data.paging && res.data.paging.next ? res.data.paging.next : null;
    params = undefined; // the "next" link already contains all needed params
  }

  return rows;
}

// ---------- Pull sales count + revenue out of the actions arrays ----------
function extractSalesAndRevenue(row) {
  let sales = 0;
  let revenue = 0;

  if (Array.isArray(row.actions)) {
    const purchaseAction = row.actions.find(
      (a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase'
    );
    if (purchaseAction) sales = parseInt(purchaseAction.value, 10) || 0;
  }

  if (Array.isArray(row.action_values)) {
    const purchaseValue = row.action_values.find(
      (a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase'
    );
    if (purchaseValue) revenue = parseFloat(purchaseValue.value) || 0;
  }

  return { sales, revenue };
}

// ---------- Telegram helpers (same style as index.js) ----------
async function sendTelegramMessage(message) {
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

function fmtMoney(n) {
  return `$${n.toFixed(2)}`;
}

// ---------- Main ----------
async function runDailyReport() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`\n===== Daily report for ${yesterday} =====`);

  // campaignName -> { spend, reach, impressions, clicks, sales, revenue, ads: [] }
  const campaigns = new Map();

  let totalSpend = 0;
  let totalSales = 0;
  let totalRevenue = 0;
  let totalReach = 0;

  for (const accountId of AD_ACCOUNT_IDS) {
    let rows = [];
    try {
      rows = await getYesterdayInsights(accountId);
    } catch (err) {
      console.error(`⚠️ Could not read insights for account ${accountId}: ${err.message}`);
      continue; // skip this account, keep going with the rest
    }

    for (const row of rows) {
      const spend = parseFloat(row.spend || 0);
      const reach = parseInt(row.reach || 0, 10);
      const impressions = parseInt(row.impressions || 0, 10);
      const clicks = parseInt(row.clicks || 0, 10);
      const { sales, revenue } = extractSalesAndRevenue(row);
      const roas = spend > 0 ? revenue / spend : 0;
      const costPerSale = sales > 0 ? spend / sales : null;

      totalSpend += spend;
      totalSales += sales;
      totalRevenue += revenue;
      totalReach += reach;

      const campaignName = row.campaign_name || '(no campaign name)';
      if (!campaigns.has(campaignName)) {
        campaigns.set(campaignName, {
          spend: 0,
          reach: 0,
          impressions: 0,
          clicks: 0,
          sales: 0,
          revenue: 0,
          ads: [],
        });
      }
      const c = campaigns.get(campaignName);
      c.spend += spend;
      c.reach += reach;
      c.impressions += impressions;
      c.clicks += clicks;
      c.sales += sales;
      c.revenue += revenue;
      c.ads.push({
        name: row.ad_name || '(no ad name)',
        adsetName: row.adset_name || '',
        spend,
        reach,
        impressions,
        clicks,
        sales,
        revenue,
        roas,
        costPerSale,
      });
    }
  }

  console.log(`Campaigns with activity: ${campaigns.size}`);
  console.log(
    `Total spend: ${fmtMoney(totalSpend)} | Total sales: ${totalSales} | Total revenue: ${fmtMoney(totalRevenue)}`
  );

  if (campaigns.size === 0) {
    await sendTelegramReport([
      `<b>📊 Rapport journalier — ${yesterday}</b>`,
      '',
      'Aucune activité (aucun spend) hier sur les comptes suivis.',
    ]);
    console.log('===== Daily report finished (no activity) =====\n');
    return;
  }

  const overallRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  const lines = [
    `<b>📊 Rapport journalier complet — ${yesterday}</b>`,
    '',
    `💰 Spend total: <b>${fmtMoney(totalSpend)}</b>`,
    `🛒 Ventes totales: <b>${totalSales}</b>`,
    `💵 Revenu total: <b>${fmtMoney(totalRevenue)}</b>`,
    `📈 ROAS global: <b>${overallRoas.toFixed(2)}x</b>`,
    `👥 Reach total: <b>${totalReach.toLocaleString()}</b>`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  // Sort campaigns by spend, descending
  const sortedCampaigns = [...campaigns.entries()].sort((a, b) => b[1].spend - a[1].spend);

  for (const [campaignName, c] of sortedCampaigns) {
    const cRoas = c.spend > 0 ? c.revenue / c.spend : 0;
    lines.push('');
    lines.push(`📁 <b>${campaignName}</b>`);
    lines.push(
      `   Spend: ${fmtMoney(c.spend)} | Ventes: ${c.sales} | Revenu: ${fmtMoney(c.revenue)} | ROAS: ${cRoas.toFixed(2)}x`
    );
    lines.push(
      `   Reach: ${c.reach.toLocaleString()} | Impressions: ${c.impressions.toLocaleString()} | Clics: ${c.clicks.toLocaleString()}`
    );

    // Sort ads within the campaign by spend, descending
    const sortedAds = [...c.ads].sort((a, b) => b.spend - a.spend);
    for (const ad of sortedAds) {
      const cps = ad.costPerSale !== null ? fmtMoney(ad.costPerSale) : '—';
      lines.push(
        `   • <b>${ad.name}</b> (${ad.adsetName})\n` +
          `     💸 ${fmtMoney(ad.spend)} | 🛒 ${ad.sales} vente(s) | 💵 ${fmtMoney(ad.revenue)} | ROAS ${ad.roas.toFixed(2)}x | Coût/vente: ${cps}\n` +
          `     👥 Reach: ${ad.reach.toLocaleString()} | Impr.: ${ad.impressions.toLocaleString()} | Clics: ${ad.clicks.toLocaleString()}`
      );
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');

  await sendTelegramReport(lines);
  console.log('===== Daily report finished =====\n');
}

runDailyReport().catch(async (err) => {
  console.error('❌ Fatal script error:', err.message);
  await sendTelegramReport([`⚠️ Daily report crashed: ${err.message}`]);
  process.exit(1);
});
