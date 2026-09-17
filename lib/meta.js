// ============================================================
// Shared helpers for talking to the Meta Marketing API.
// Used by both index.js (monitor cycle) and restart-winners.js.
// ============================================================

const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function extractSales(row) {
  let sales = 0;
  if (Array.isArray(row.actions)) {
    const purchaseAction = row.actions.find(
      (a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase'
    );
    if (purchaseAction) sales = parseInt(purchaseAction.value, 10) || 0;
  }
  return sales;
}

// ---------- Fetch active ads for one account ----------
async function getActiveAds(token, accountId) {
  const url = `${BASE_URL}/${accountId}/ads`;
  const ads = [];
  let nextUrl = url;
  let params = {
    access_token: token,
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

// ---------- Fetch spend + sales for one ad over a given period ----------
// datePreset examples: 'today', 'maximum' (lifetime since the ad was created)
async function getAdStats(token, adId, datePreset) {
  const url = `${BASE_URL}/${adId}/insights`;
  const params = {
    access_token: token,
    fields: 'spend,actions',
    date_preset: datePreset,
  };

  const res = await axios.get(url, { params });
  const row = res.data.data && res.data.data[0];

  if (!row) return { spend: 0, sales: 0 };

  const spend = parseFloat(row.spend || 0);
  const sales = extractSales(row);
  return { spend, sales };
}

// ---------- Pause / activate an ad ----------
async function pauseAd(token, adId) {
  const url = `${BASE_URL}/${adId}`;
  await axios.post(url, null, { params: { status: 'PAUSED', access_token: token } });
}

async function activateAd(token, adId) {
  const url = `${BASE_URL}/${adId}`;
  await axios.post(url, null, { params: { status: 'ACTIVE', access_token: token } });
}

// ---------- Duplicate an ad exactly (same budget/targeting/creative) ----------
// Returns the new ad's id, or null if Meta didn't return one.
async function duplicateAd(token, adId, nameSuffix) {
  const url = `${BASE_URL}/${adId}/copies`;
  const params = {
    access_token: token,
    status_option: 'ACTIVE', // give it its second chance right away
  };
  if (nameSuffix) {
    params.rename_options = JSON.stringify({
      rename_strategy: 'ONLY_TOP_LEVEL_RENAME',
      rename_suffix: nameSuffix,
    });
  }
  const res = await axios.post(url, null, { params });
  return res.data.ad_id || res.data.copied_ad_id || null;
}

module.exports = { getActiveAds, getAdStats, pauseAd, activateAd, duplicateAd };
