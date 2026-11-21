// 日本時間 (JST, UTC+9 / サマータイムなし) を扱うユーティリティ
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

// JST の暦日・時刻から epoch ms を得る（day は範囲外でも Date が繰り上げ/繰り下げする）
function jstToMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour || 0, minute || 0) - JST_OFFSET_MS;
}

// "YYYY-MM-DDTHH:mm" (JST) -> epoch ms
function parseJstLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return jstToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

// ISO8601（オフセット付き）または JST ローカル表記を epoch ms に
function parseDateInput(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const s = String(value);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return parseJstLocal(s);
}

function parseHHmm(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return fallback;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function formatJst(ms) {
  const p = jstParts(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: p.month + '月' + p.day + '日(' + WEEKDAYS[p.weekday] + ')',
    time: pad(p.hour) + ':' + pad(p.minute),
    iso: p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute),
  };
}

module.exports = { jstParts, jstToMs, parseJstLocal, parseDateInput, parseHHmm, formatJst };
