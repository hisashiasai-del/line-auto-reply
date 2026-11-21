// 連絡先・面談・リマインドの管理 API（/api 配下）
const express = require('express');
const router = express.Router();
const store = require('./reminders/store');
const { parseDateInput } = require('./reminders/time');
const { sendDueReminders } = require('./reminders/sender');
const { syncCalendar } = require('./reminders/googleCalendar');
const { detectForConversation } = require('./reminders/chatDetector');

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
}

function notFound(what) {
  const e = new Error(what + ' not found');
  e.status = 404;
  return e;
}

// ---- 連絡先 ----
router.get('/contacts', handle(() => store.listContacts()));
router.post('/contacts', handle((req) => store.createContact(req.body || {})));
router.patch('/contacts/:id', handle((req) => {
  if (!store.getContact(req.params.id)) throw notFound('contact');
  return store.updateContact(Number(req.params.id), req.body || {});
}));

// ---- 面談（DB に直接登録する経路） ----
router.get('/meetings', handle((req) => {
  const from = req.query.from ? parseDateInput(req.query.from) : Date.now() - 24 * 60 * 60 * 1000;
  return store.listUpcomingMeetings(from);
}));

router.post('/meetings', handle((req) => {
  const b = req.body || {};
  const startAt = parseDateInput(b.start_at);
  if (!b.title || !startAt) throw new Error('title and start_at (例: 2026-11-25T10:00 / ISO8601) are required');
  const participantIds = (b.participant_ids || []).map(Number);
  for (const id of participantIds) if (!store.getContact(id)) throw notFound('contact ' + id);
  return store.createMeeting({
    title: b.title,
    meetingType: b.meeting_type,
    startAt,
    endAt: parseDateInput(b.end_at),
    location: b.location,
    notes: b.notes,
    source: 'database',
    participantIds,
    addedBy: 'database',
  });
}));

router.patch('/meetings/:id', handle((req) => {
  const id = Number(req.params.id);
  if (!store.getMeeting(id)) throw notFound('meeting');
  const b = req.body || {};
  if (b.status && !['scheduled', 'cancelled'].includes(b.status)) throw new Error('status must be scheduled or cancelled');
  return store.updateMeeting(id, {
    title: b.title,
    meetingType: b.meeting_type,
    startAt: b.start_at !== undefined ? parseDateInput(b.start_at) : undefined,
    endAt: b.end_at !== undefined ? parseDateInput(b.end_at) : undefined,
    location: b.location,
    notes: b.notes,
    status: b.status,
  });
}));

router.post('/meetings/:id/participants', handle((req) => {
  const id = Number(req.params.id);
  const contactId = Number((req.body || {}).contact_id);
  if (!store.getMeeting(id)) throw notFound('meeting');
  if (!store.getContact(contactId)) throw notFound('contact');
  store.addParticipant(id, contactId, 'manual');
  store.syncRemindersForMeeting(id);
  return { ok: true, participants: store.getParticipants(id) };
}));

router.delete('/meetings/:id/participants/:contactId', handle((req) => {
  store.removeParticipant(Number(req.params.id), Number(req.params.contactId));
  return { ok: true };
}));

// ---- リマインド ----
router.get('/reminders', handle((req) => store.listReminders(req.query.status)));
router.post('/reminders/run', handle(() => sendDueReminders()));

// ---- 手動トリガー ----
router.post('/calendar/sync', handle(() => syncCalendar()));
router.post('/detect', handle((req) => {
  const { channel, id } = req.body || {};
  if (!['line', 'messenger'].includes(channel) || !id) throw new Error('channel (line|messenger) and id are required');
  return detectForConversation(channel, id);
}));

module.exports = router;
