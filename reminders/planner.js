// 面談の開始時刻からリマインド送信時刻を決める（純粋関数）
const { jstParts, jstToMs, parseHHmm } = require('./time');

const DAY_BEFORE = parseHHmm(process.env.REMINDER_DAY_BEFORE_TIME, { hour: 12, minute: 0 });
const SAME_DAY = parseHHmm(process.env.REMINDER_SAME_DAY_TIME, { hour: 9, minute: 0 });
// 送り逃したリマインドを「今すぐ」送るのは、面談開始までこの時間以上ある場合のみ
const CATCH_UP_MIN_LEAD_MS = Number(process.env.REMINDER_CATCH_UP_MIN_LEAD_MINUTES || 30) * 60 * 1000;
// 次の定時リマインドがこの時間以内に来るなら、送り逃し分は送らない（短時間の二重送信を避ける）
const CATCH_UP_MIN_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * @returns {Array<{kind: 'day_before'|'same_day', sendAt: number}>}
 *  - day_before: 前日 12:00 (JST)
 *  - same_day:   当日 09:00 (JST)
 *  面談開始以降になる枠は作らない。過去になった枠は、最新の1枠だけ「今すぐ」送り、それ以前は省く。
 */
function planReminders(startAt, now) {
  if (!startAt || startAt <= now) return [];
  const p = jstParts(startAt);
  const slots = [
    { kind: 'day_before', sendAt: jstToMs(p.year, p.month, p.day - 1, DAY_BEFORE.hour, DAY_BEFORE.minute) },
    { kind: 'same_day', sendAt: jstToMs(p.year, p.month, p.day, SAME_DAY.hour, SAME_DAY.minute) },
  ].filter((s) => s.sendAt < startAt);

  const future = slots.filter((s) => s.sendAt > now);
  const past = slots.filter((s) => s.sendAt <= now);
  const result = [...future];
  // 送り逃した直近の1枠は、面談まで余裕があり、次の枠もすぐ来ないときだけ「今すぐ」送る
  //  例: 前日15時に登録された翌朝10時の面談 -> 前日分を今すぐ + 当日9時分
  //  例: 当日8時に登録された14時の面談     -> 9時にすぐ当日分が出るので前日分は省く
  const latestPast = past[past.length - 1];
  const nextFuture = future[0];
  if (
    latestPast &&
    startAt - now >= CATCH_UP_MIN_LEAD_MS &&
    (!nextFuture || nextFuture.sendAt - now >= CATCH_UP_MIN_GAP_MS)
  ) {
    result.unshift({ kind: latestPast.kind, sendAt: now });
  }
  return result;
}

module.exports = { planReminders };
