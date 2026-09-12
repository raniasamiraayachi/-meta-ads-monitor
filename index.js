// ============================================================
// نظام المراقبة التلقائية للإعلانات (Meta Ads Auto Monitor)
// كل مرة يتشغل، يفحص كل الإعلانات النشيطة، ويوقف اللي وصلت لشرط التوقف
// ============================================================

const axios = require('axios');

// ---------- الإعدادات (تجي من GitHub Secrets) ----------
const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_IDS = (process.env.AD_ACCOUNT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SPEND_THRESHOLD = parseFloat(process.env.SPEND_THRESHOLD || '2');
const MIN_SALES = parseInt(process.env.MIN_SALES || '0', 10); // 0 مبيعة = شرط التوقف
const DATE_PRESET = process.env.DATE_PRESET || 'today'; // الفترة اللي نحسبو فيها الأرقام
const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

if (!TOKEN || AD_ACCOUNT_IDS.length === 0) {
  console.error('❌ خطأ: خاصك تحطي META_ACCESS_TOKEN و AD_ACCOUNT_IDS فـ GitHub Secrets');
  process.exit(1);
}

// ---------- جلب الإعلانات النشيطة فحساب معين ----------
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
    params = undefined; // الـ next رابط كامل فيه كلشي، ما نعاودوش نبعتو params
  }

  return ads;
}

// ---------- جلب الإنفاق وعدد المبيعات لإعلان معين ----------
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
    // ماكاينش بيانات (الإعلان ماصرفش والو اليوم مثلا) = صرف 0 ومبيعات 0
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

// ---------- إيقاف إعلان ----------
async function pauseAd(adId) {
  const url = `${BASE_URL}/${adId}`;
  await axios.post(url, null, {
    params: { status: 'PAUSED', access_token: TOKEN },
  });
}

// ---------- الدورة الكاملة ----------
async function runCycle() {
  const startTime = new Date().toISOString();
  console.log(`\n===== بداية الدورة: ${startTime} =====`);

  let checked = 0;
  let paused = 0;
  let skipped = 0;

  for (const accountId of AD_ACCOUNT_IDS) {
    console.log(`\n--- حساب: ${accountId} ---`);

    let ads = [];
    try {
      ads = await getActiveAds(accountId);
    } catch (err) {
      console.error(`⚠️ ما قدرتش نقرا إعلانات الحساب ${accountId}: ${err.message}`);
      continue; // نتخطى الحساب هذا، نكمل الباقي
    }

    console.log(`عدد الإعلانات النشيطة: ${ads.length}`);

    for (const ad of ads) {
      checked++;
      try {
        const { spend, sales } = await getAdStats(ad.id);

        if (spend >= SPEND_THRESHOLD && sales <= MIN_SALES) {
          await pauseAd(ad.id);
          paused++;
          console.log(
            `🛑 توقف: "${ad.name}" | صرف: $${spend.toFixed(2)} | مبيعات: ${sales}`
          );
        } else {
          console.log(
            `✅ يبقى شغال: "${ad.name}" | صرف: $${spend.toFixed(2)} | مبيعات: ${sales}`
          );
        }
      } catch (err) {
        // قاعدة مهمة: أي خطأ فالقراءة = نتخطى الإعلان بلا ما نلمسوه
        skipped++;
        console.error(`⏭️ تخطي "${ad.name}" (خطأ فالقراءة): ${err.message}`);
      }
    }
  }

  console.log(`\n===== ملخص الدورة =====`);
  console.log(`إجمالي الإعلانات المفحوصة: ${checked}`);
  console.log(`تم إيقافها: ${paused}`);
  console.log(`تم تخطيها (خطأ قراءة): ${skipped}`);
  console.log(`===== نهاية الدورة =====\n`);
}

runCycle().catch((err) => {
  console.error('❌ خطأ عام فالسكريبت:', err.message);
  process.exit(1);
});
