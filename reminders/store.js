// 連絡先・面談・リマインドの永続化と、面談→リマインドの同期
const { db } = require('../db');
const { planReminders } = require('./planner');

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'freelancer',      -- freelancer | company
  company_name TEXT,
  email TEXT UNIQUE,
  line_user_id TEXT UNIQUE,
  messenger_psid TEXT UNIQUE,
  reminders_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  meeting_type TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  location TEXT,
  source TEXT NOT NULL,                         -- database | google_calendar | line | messenger
  external_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'scheduled',     -- scheduled | cancelled
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_at);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (meeting_id, contact_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                           -- day_before | same_day
  meeting_start_at INTEGER NOT NULL,            -- 作成時点の面談開始時刻（日程変更の検知用）
  channel TEXT,                                 -- line | messenger
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',     -- scheduled | sending | sent | failed | cancelled | no_channel
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  message_text TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (meeting_id, contact_id, kind, meeting_start_at)
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, send_at);

CREATE TABLE IF NOT EXISTS messenger_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  psid TEXT NOT NULL,
  sender TEXT NOT NULL,                         -- user | staff
  text TEXT NOT NULL,
  mid TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messenger_messages_psid ON messenger_messages(psid, created_at);
`);

// ---------- contacts ----------

function getContact(id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function listContacts() {
  return db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all();
}

function findContactBy(field, value) {
  if (!value) return null;
  if (!['line_user_id', 'messenger_psid', 'email'].includes(field)) throw new Error('bad field');
  return db.prepare('SELECT * FROM contacts WHERE ' + field + ' = ?').get(value);
}

// LINE/Messenger の相手を連絡先として登録（既存なら名前だけ補完）
// 既定: LINE = フリーランス、Messenger = 企業
function upsertContactFromChannel(channel, channelId, name) {
  const field = channel === 'line' ? 'line_user_id' : 'messenger_psid';
  const kind = channel === 'line' ? 'freelancer' : 'company';
  const now = Date.now();
  const existing = findContactBy(field, channelId);
  if (existing) {
    if (name && !existing.name) {
      db.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').run(name, now, existing.id);
    }
    return getContact(existing.id);
  }
  const info = db
    .prepare('INSERT INTO contacts (name, kind, ' + field + ', created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(name || null, kind, channelId, now, now);
  return getContact(info.lastInsertRowid);
}

const CONTACT_FIELDS = ['name', 'kind', 'company_name', 'email', 'line_user_id', 'messenger_psid', 'reminders_enabled'];

function createContact(fields) {
  const now = Date.now();
  const cols = CONTACT_FIELDS.filter((f) => fields[f] !== undefined);
  const info = db
    .prepare(
      'INSERT INTO contacts (' + cols.concat(['created_at', 'updated_at']).join(', ') + ') VALUES (' +
        cols.map(() => '?').concat(['?', '?']).join(', ') + ')'
    )
    .run(...cols.map((c) => normalizeContactValue(c, fields[c])), now, now);
  return getContact(info.lastInsertRowid);
}

function updateContact(id, fields) {
  const cols = CONTACT_FIELDS.filter((f) => fields[f] !== undefined);
  if (cols.length) {
    db.prepare('UPDATE contacts SET ' + cols.map((c) => c + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?')
      .run(...cols.map((c) => normalizeContactValue(c, fields[c])), Date.now(), id);
  }
  // 連絡手段や種別が変わったら、未送信リマインドの送信チャネルを付け直す
  for (const r of db.prepare("SELECT DISTINCT meeting_id FROM reminders WHERE contact_id = ? AND status IN ('scheduled','no_channel')").all(id)) {
    syncRemindersForMeeting(r.meeting_id);
  }
  return getContact(id);
}

function normalizeContactValue(col, v) {
  if (col === 'reminders_enabled') return v ? 1 : 0;
  if (col === 'kind' && !['freelancer', 'company'].includes(v)) throw new Error('kind must be freelancer or company');
  if (col === 'email' && v) return String(v).trim().toLowerCase();
  return v === '' ? null : v;
}

// 連絡手段の決定: フリーランス=公式LINE優先、企業=Messenger優先。無ければもう一方。
function resolveChannel(contact) {
  const order = contact.kind === 'company' ? ['messenger', 'line'] : ['line', 'messenger'];
  for (const ch of order) {
    if (ch === 'line' && contact.line_user_id) return 'line';
    if (ch === 'messenger' && contact.messenger_psid) return 'messenger';
  }
  return null;
}

// ---------- meetings ----------

function getMeeting(id) {
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function getParticipants(meetingId) {
  return db
    .prepare('SELECT c.* FROM meeting_participants mp JOIN contacts c ON c.id = mp.contact_id WHERE mp.meeting_id = ?')
    .all(meetingId);
}

function addParticipant(meetingId, contactId, addedBy) {
  db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, contact_id, added_by) VALUES (?, ?, ?)')
    .run(meetingId, contactId, addedBy || null);
}

function removeParticipant(meetingId, contactId) {
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ? AND contact_id = ?').run(meetingId, contactId);
  syncRemindersForMeeting(meetingId);
}

function createMeeting({ title, meetingType, startAt, endAt, location, source, externalId, notes, participantIds, addedBy }) {
  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO meetings (title, meeting_type, start_at, end_at, location, source, external_id, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'scheduled\', ?, ?, ?)'
    )
    .run(title, meetingType || null, startAt, endAt || null, location || null, source, externalId || null, notes || null, now, now);
  const id = info.lastInsertRowid;
  for (const cid of participantIds || []) addParticipant(id, cid, addedBy || source);
  syncRemindersForMeeting(id);
  return getMeeting(id);
}

function updateMeeting(id, fields) {
  const map = { title: 'title', meetingType: 'meeting_type', startAt: 'start_at', endAt: 'end_at', location: 'location', status: 'status', notes: 'notes' };
  const cols = Object.keys(map).filter((k) => fields[k] !== undefined);
  if (cols.length) {
    db.prepare('UPDATE meetings SET ' + cols.map((k) => map[k] + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?')
      .run(...cols.map((k) => fields[k]), Date.now(), id);
  }
  syncRemindersForMeeting(id);
  return getMeeting(id);
}

function setMeetingSource(id, source, externalId) {
  db.prepare('UPDATE meetings SET source = ?, external_id = ?, updated_at = ? WHERE id = ?').run(source, externalId || null, Date.now(), id);
}

function findMeetingByExternalId(externalId) {
  return db.prepare('SELECT * FROM meetings WHERE external_id = ?').get(externalId);
}

function findScheduledMeetingsAt(startAt) {
  return db.prepare("SELECT * FROM meetings WHERE status = 'scheduled' AND start_at = ?").all(startAt);
}

function findMeetingForContactAt(contactId, startAt) {
  return db
    .prepare(
      "SELECT m.* FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id WHERE mp.contact_id = ? AND m.start_at = ? AND m.status = 'scheduled'"
    )
    .get(contactId, startAt);
}

function listUpcomingMeetings(fromMs) {
  const meetings = db
    .prepare('SELECT * FROM meetings WHERE start_at >= ? ORDER BY start_at ASC LIMIT 200')
    .all(fromMs);
  return meetings.map((m) => ({
    ...m,
    participants: getParticipants(m.id),
    reminders: db.prepare('SELECT * FROM reminders WHERE meeting_id = ? AND meeting_start_at = ? ORDER BY send_at').all(m.id, m.start_at),
  }));
}

// ---------- reminders ----------

/**
 * 面談の現在の状態に合わせてリマインドを作成・更新・取り消しする（冪等）。
 *  - 日程変更: 旧日時ぶんの未送信リマインドを取り消し、新日時ぶんを作成
 *  - キャンセル: 未送信リマインドを取り消し
 *  - 参加者の追加/削除や連絡手段の変更にも追随
 */
function syncRemindersForMeeting(meetingId, now) {
  now = now || Date.now();
  const meeting = getMeeting(meetingId);
  if (!meeting) return;

  const tx = db.transaction(() => {
    const participants = getParticipants(meetingId);
    const activeIds = new Set(
      meeting.status === 'scheduled' ? participants.filter((p) => p.reminders_enabled).map((p) => p.id) : []
    );

    // 不要になった未送信リマインドを取り消す
    const pending = db
      .prepare("SELECT * FROM reminders WHERE meeting_id = ? AND status IN ('scheduled','no_channel')")
      .all(meetingId);
    for (const r of pending) {
      if (r.meeting_start_at !== meeting.start_at || !activeIds.has(r.contact_id)) {
        db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r.id);
      }
    }
    if (meeting.status !== 'scheduled') return;

    const plan = planReminders(meeting.start_at, now);
    for (const contact of participants.filter((p) => activeIds.has(p.id))) {
      const channel = resolveChannel(contact);
      const status = channel ? 'scheduled' : 'no_channel';
      for (const slot of plan) {
        const existing = db
          .prepare('SELECT * FROM reminders WHERE meeting_id = ? AND contact_id = ? AND kind = ? AND meeting_start_at = ?')
          .get(meetingId, contact.id, slot.kind, meeting.start_at);
        if (!existing) {
          db.prepare(
            'INSERT INTO reminders (meeting_id, contact_id, kind, meeting_start_at, channel, send_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(meetingId, contact.id, slot.kind, meeting.start_at, channel, slot.sendAt, status, now);
        } else if (['scheduled', 'no_channel', 'cancelled'].includes(existing.status)) {
          // 送信済み・失敗は触らない。取り消し済みは（キャンセル→復活などで）再度有効化
          const sendAt = existing.status === 'cancelled' ? slot.sendAt : existing.send_at;
          db.prepare('UPDATE reminders SET channel = ?, status = ?, send_at = ? WHERE id = ?')
            .run(channel, status, sendAt, existing.id);
        }
      }
    }
  });
  tx();
}

// 送信対象を取り出して 'sending' に切り替える（多重送信防止）
function claimDueReminders(now, limit) {
  const claim = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT r.* FROM reminders r JOIN meetings m ON m.id = r.meeting_id
         WHERE r.status = 'scheduled' AND r.send_at <= ? AND m.status = 'scheduled'
           AND m.start_at = r.meeting_start_at AND m.start_at > ?
         ORDER BY r.send_at ASC LIMIT ?`
      )
      .all(now, now, limit || 50);
    for (const r of rows) db.prepare("UPDATE reminders SET status = 'sending' WHERE id = ?").run(r.id);
    return rows;
  });
  return claim();
}

function markReminderSent(id, text, now) {
  db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?, message_text = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?")
    .run(now, text, id);
}

function markReminderFailed(id, error, retryAt, maxAttempts) {
  const r = db.prepare('SELECT attempts FROM reminders WHERE id = ?').get(id);
  const attempts = (r ? r.attempts : 0) + 1;
  if (attempts >= maxAttempts || retryAt == null) {
    db.prepare("UPDATE reminders SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, error, id);
  } else {
    db.prepare("UPDATE reminders SET status = 'scheduled', attempts = ?, last_error = ?, send_at = ? WHERE id = ?").run(attempts, error, retryAt, id);
  }
}

// 起動時: 前回プロセスが送信途中で落ちたものを戻す
function resetStuckReminders() {
  db.prepare("UPDATE reminders SET status = 'scheduled' WHERE status = 'sending'").run();
}

// 送信時刻を過ぎて面談も始まってしまった未送信分を整理
function expireStaleReminders(now) {
  db.prepare(
    `UPDATE reminders SET status = 'cancelled', last_error = 'expired'
     WHERE status IN ('scheduled','no_channel') AND meeting_id IN (SELECT id FROM meetings WHERE start_at <= ?)`
  ).run(now);
}

function listReminders(status) {
  const sql =
    `SELECT r.*, m.title AS meeting_title, m.start_at AS current_meeting_start_at, c.name AS contact_name, c.kind AS contact_kind
     FROM reminders r JOIN meetings m ON m.id = r.meeting_id JOIN contacts c ON c.id = r.contact_id` +
    (status ? ' WHERE r.status = ?' : '') +
    ' ORDER BY r.send_at DESC LIMIT 300';
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

// ---------- messenger messages ----------

function addMessengerMessage(psid, sender, text, timestamp, mid) {
  db.prepare('INSERT OR IGNORE INTO messenger_messages (psid, sender, text, mid, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(psid, sender, text, mid || null, timestamp);
}

function getMessengerHistory(psid, limit) {
  return db
    .prepare('SELECT sender, text, created_at FROM messenger_messages WHERE psid = ? ORDER BY created_at DESC LIMIT ?')
    .all(psid, limit || 30)
    .reverse();
}

function getLastMessengerUserMessageAt(psid) {
  const r = db.prepare("SELECT MAX(created_at) AS t FROM messenger_messages WHERE psid = ? AND sender = 'user'").get(psid);
  return r ? r.t : null;
}

module.exports = {
  getContact,
  listContacts,
  findContactBy,
  upsertContactFromChannel,
  createContact,
  updateContact,
  resolveChannel,
  getMeeting,
  getParticipants,
  addParticipant,
  removeParticipant,
  createMeeting,
  updateMeeting,
  setMeetingSource,
  findMeetingByExternalId,
  findScheduledMeetingsAt,
  findMeetingForContactAt,
  listUpcomingMeetings,
  syncRemindersForMeeting,
  claimDueReminders,
  markReminderSent,
  markReminderFailed,
  resetStuckReminders,
  expireStaleReminders,
  listReminders,
  addMessengerMessage,
  getMessengerHistory,
  getLastMessengerUserMessageAt,
};
