// ============================================================
// Algeria has no daylight saving time — it's UTC+1 year-round.
// ============================================================

function algeriaDateString(d = new Date()) {
  const shifted = new Date(d.getTime() + 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function previousDateString(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { algeriaDateString, previousDateString };
