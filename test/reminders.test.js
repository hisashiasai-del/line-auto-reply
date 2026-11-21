process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { jstToMs, formatJst } = require('../reminders/time');
const { planReminders } = require('../reminders/planner');
const store = require('../reminders/store');
const { db } = require('../db');
const { applyDetections } = require('../reminders/chatDetector');
const { buildReminderText } = require('../reminders/templates');
const { matchContacts } = require('../reminders/googleCalendar');
const lineClient = require('../lineClient');
const messengerClient = require('../messengerClient');
const { sendDueReminders } = require('../reminders/sender');

const HOUR = 60 * 60 * 1000;

function reset() {
  db.exec('DELETE FROM reminders; DELETE FROM meeting_participants; DELETE FROM meetings; DELETE FROM contacts; DELETE FROM messenger_messages; DELETE FROM messages;');
}

function setup() {
  reset();
  const freelancer = store.upsertContactFromChannel('line', 'U_free', '山田 太郎');
  const company = store.upsertContactFromChannel('messenger', 'PSID_corp', '佐藤 花子');
  store.updateContact(company.id, { company_name: '株式会社ABC' });
  return { freelancer: store.getContact(freelancer.id), company: store.getContact(company.id) };
}

test('翌朝10時の面談: 前日12:00 と 当日9:00 にリマインド', () => {
  const start = jstToMs(2026, 11, 25, 10, 0);
  const now = jstToMs(2026, 11, 23, 15, 0);
  assert.deepEqual(planReminders(start, now), [
    { kind: 'day_before', sendAt: jstToMs(2026, 11, 24, 12, 0) },
    { kind: 'same_day', sendAt: jstToMs(2026, 11, 25, 9, 0) },
  ]);
});

test('月初の面談でも前日は前月末日になる', () => {
  const start = jstToMs(2026, 12, 1, 10, 0);
  const plan = planReminders(start, jstToMs(2026, 11, 20, 0, 0));
  assert.equal(formatJst(plan[0].sendAt).iso, '2026-11-30T12:00');
});

test('朝8時半開始の面談は当日9時リマインドを作らない', () => {
  const start = jstToMs(2026, 11, 25, 8, 30);
  const plan = planReminders(start, jstToMs(2026, 11, 20, 0, 0));
  assert.deepEqual(plan.map((p) => p.kind), ['day_before']);
});

test('前日12時を過ぎてから登録: 前日分は即時送信、当日9時分は通常', () => {
  const start = jstToMs(2026, 11, 25, 10, 0);
  const now = jstToMs(2026, 11, 24, 15, 0);
  assert.deepEqual(planReminders(start, now), [
    { kind: 'day_before', sendAt: now },
    { kind: 'same_day', sendAt: jstToMs(2026, 11, 25, 9, 0) },
  ]);
});

test('当日8時に登録された14時の面談: 9時の当日分のみ（直前の二重送信を避ける）', () => {
  const start = jstToMs(2026, 11, 25, 14, 0);
  const now = jstToMs(2026, 11, 25, 8, 0);
  assert.deepEqual(planReminders(start, now).map((p) => p.kind), ['same_day']);
});

test('当日10時に登録された14時の面談: 当日分を即時送信', () => {
  const start = jstToMs(2026, 11, 25, 14, 0);
  const now = jstToMs(2026, 11, 25, 10, 0);
  assert.deepEqual(planReminders(start, now), [{ kind: 'same_day', sendAt: now }]);
});

test('三者面談: フリーランスはLINE、企業はMessengerで各2通', () => {
  const { freelancer, company } = setup();
  const m = store.createMeeting({
    title: '三者面談',
    startAt: Date.now() + 3 * 24 * HOUR,
    source: 'database',
    participantIds: [freelancer.id, company.id],
  });
  const rows = db.prepare('SELECT contact_id, kind, channel, status FROM reminders WHERE meeting_id = ? ORDER BY contact_id, kind').all(m.id);
  assert.deepEqual(rows, [
    { contact_id: freelancer.id, kind: 'day_before', channel: 'line', status: 'scheduled' },
    { contact_id: freelancer.id, kind: 'same_day', channel: 'line', status: 'scheduled' },
    { contact_id: company.id, kind: 'day_before', channel: 'messenger', status: 'scheduled' },
    { contact_id: company.id, kind: 'same_day', channel: 'messenger', status: 'scheduled' },
  ]);
});

test('日程変更で旧日時分は取り消し・新日時分を作成、キャンセルで全取り消し', () => {
  const { freelancer } = setup();
  const m = store.createMeeting({ title: '面談', startAt: Date.now() + 3 * 24 * HOUR, source: 'database', participantIds: [freelancer.id] });
  store.updateMeeting(m.id, { startAt: Date.now() + 5 * 24 * HOUR });
  const counts = db.prepare('SELECT status, COUNT(*) n FROM reminders WHERE meeting_id = ? GROUP BY status ORDER BY status').all(m.id);
  assert.deepEqual(counts, [{ status: 'cancelled', n: 2 }, { status: 'scheduled', n: 2 }]);
  store.updateMeeting(m.id, { status: 'cancelled' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders WHERE meeting_id = ? AND status = 'scheduled'").get(m.id).n, 0);
});

test('連絡手段が無い連絡先は no_channel、手段を登録すると scheduled に', () => {
  reset();
  const c = store.createContact({ name: '鈴木', kind: 'company', email: 'suzuki@example.com' });
  const m = store.createMeeting({ title: '面談', startAt: Date.now() + 3 * 24 * HOUR, source: 'database', participantIds: [c.id] });
  assert.equal(db.prepare('SELECT status FROM reminders WHERE meeting_id = ? LIMIT 1').get(m.id).status, 'no_channel');
  store.updateContact(c.id, { messenger_psid: 'PSID_x' });
  const r = db.prepare('SELECT status, channel FROM reminders WHERE meeting_id = ? LIMIT 1').get(m.id);
  assert.deepEqual({ ...r }, { status: 'scheduled', channel: 'messenger' });
});

test('チャット検知: フリーランス側LINEで作成 → 企業側Messengerの同時刻が合流 → 1件の三者面談', () => {
  const { freelancer, company } = setup();
  const now = Date.now();
  const start = formatJst(now + 3 * 24 * HOUR).iso.slice(0, 11) + '10:00';
  const det = (over) => ({
    status: 'confirmed', start_at_jst: start, previous_start_at_jst: null, meeting_type: '三者面談',
    title: '三者面談', location_or_url: null, counterpart_names: [], ...over,
  });
  const r1 = applyDetections(freelancer, 'line', [det({ counterpart_names: ['株式会社ABC'] })], now);
  assert.equal(r1[0].action, 'created');
  const r2 = applyDetections(company, 'messenger', [det({ counterpart_names: ['山田さん'], location_or_url: 'https://meet.example/abc' })], now);
  assert.deepEqual(r2, [{ action: 'joined', meetingId: r1[0].meetingId }]);
  assert.equal(store.getParticipants(r1[0].meetingId).length, 2);
  assert.equal(store.getMeeting(r1[0].meetingId).location, 'https://meet.example/abc');
  // 同じ内容をもう一度検知しても重複しない
  assert.equal(applyDetections(freelancer, 'line', [det()], now)[0].action, 'unchanged');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders WHERE status = 'scheduled'").get().n, 4);

  // 企業側がキャンセル → カレンダー外のチャット由来でも参加者2名なので企業だけ外れる
  applyDetections(company, 'messenger', [det({ status: 'cancelled' })], now);
  assert.deepEqual(store.getParticipants(r1[0].meetingId).map((p) => p.id), [freelancer.id]);
});

test('チャット検知: tentative は登録しない / 日程変更はチャット由来の面談を移動', () => {
  const { freelancer } = setup();
  const now = Date.now();
  const day = formatJst(now + 3 * 24 * HOUR).iso.slice(0, 11);
  assert.deepEqual(applyDetections(freelancer, 'line', [{ status: 'tentative', start_at_jst: day + '10:00', previous_start_at_jst: null, meeting_type: '面談', title: '面談', location_or_url: null, counterpart_names: [] }], now), []);
  const [c] = applyDetections(freelancer, 'line', [{ status: 'confirmed', start_at_jst: day + '10:00', previous_start_at_jst: null, meeting_type: '面談', title: '面談', location_or_url: null, counterpart_names: [] }], now);
  const [moved] = applyDetections(freelancer, 'line', [{ status: 'confirmed', start_at_jst: day + '15:00', previous_start_at_jst: day + '10:00', meeting_type: '面談', title: '面談', location_or_url: null, counterpart_names: [] }], now);
  assert.deepEqual(moved, { action: 'rescheduled', meetingId: c.meetingId });
  assert.equal(formatJst(store.getMeeting(c.meetingId).start_at).iso, day + '15:00');
});

test('カレンダー予定の参加者をメール・名前で特定', () => {
  const { freelancer, company } = setup();
  store.updateContact(company.id, { email: 'hanako@abc.co.jp' });
  const ids = matchContacts(
    { summary: '【三者面談】山田太郎様 × ABC', attendees: [{ email: 'Hanako@abc.co.jp' }] },
    store.listContacts()
  );
  assert.deepEqual(ids.sort(), [freelancer.id, company.id].sort());
});

test('文面: 前日と当日', () => {
  const { company } = setup();
  const meeting = { title: '三者面談', start_at: jstToMs(2026, 11, 25, 10, 0), location: 'https://meet.example/x' };
  const t1 = buildReminderText({ kind: 'day_before' }, meeting, company);
  assert.match(t1, /株式会社ABC 佐藤 花子様/);
  assert.match(t1, /明日 11月25日\(水\) 10:00より、「三者面談」/);
  assert.match(t1, /meet\.example/);
  assert.match(buildReminderText({ kind: 'same_day' }, meeting, company), /本日 11月25日\(水\) 10:00/);
});

test('送信: 期限到来分を各チャネルで自動送信し、失敗はリトライ', async () => {
  const { freelancer, company } = setup();
  const sent = [];
  lineClient.pushMessage = async (to, text) => sent.push(['line', to, text]);
  let fail = true;
  messengerClient.sendText = async (psid, text) => {
    if (fail) throw new Error('graph error');
    sent.push(['messenger', psid, text]);
  };
  const m = store.createMeeting({ title: '三者面談', startAt: Date.now() + 2 * 24 * HOUR, source: 'database', participantIds: [freelancer.id, company.id] });
  db.prepare("UPDATE reminders SET send_at = ? WHERE meeting_id = ? AND kind = 'day_before'").run(Date.now() - 1000, m.id);

  const r1 = await sendDueReminders();
  assert.deepEqual(r1, { sent: 1, failed: 1 });
  assert.deepEqual(sent.map((s) => s.slice(0, 2)), [['line', 'U_free']]);
  const failed = db.prepare("SELECT * FROM reminders WHERE contact_id = ? AND kind = 'day_before'").get(company.id);
  assert.equal(failed.status, 'scheduled');
  assert.equal(failed.attempts, 1);

  fail = false;
  db.prepare('UPDATE reminders SET send_at = ? WHERE id = ?').run(Date.now() - 1000, failed.id);
  const r2 = await sendDueReminders();
  assert.deepEqual(r2, { sent: 1, failed: 0 });
  assert.equal(sent[1][0], 'messenger');
  // 送信済みは再送されない
  assert.deepEqual(await sendDueReminders(), { sent: 0, failed: 0 });
  // 送信内容は会話履歴にも残る
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE line_user_id = 'U_free' AND sender = 'staff'").get().n, 1);
});
