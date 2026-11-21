// 期限が来たリマインドを自動送信する（承認なし）
const store = require('./store');
const { buildReminderText } = require('./templates');
const lineClient = require('../lineClient');
const messengerClient = require('../messengerClient');
const { addMessage } = require('../db');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;

async function deliver(channel, contact, text) {
  if (channel === 'line') {
    await lineClient.pushMessage(contact.line_user_id, text);
    addMessage(contact.line_user_id, 'staff', text, Date.now());
    return;
  }
  if (channel === 'messenger') {
    const lastUserAt = store.getLastMessengerUserMessageAt(contact.messenger_psid);
    await messengerClient.sendText(contact.messenger_psid, text, lastUserAt);
    store.addMessengerMessage(contact.messenger_psid, 'staff', text, Date.now());
    return;
  }
  throw new Error('no channel available');
}

function describeError(err) {
  const data = err && err.response && err.response.data;
  return (err && err.message ? err.message : String(err)) + (data ? ' ' + JSON.stringify(data) : '');
}

let running = false;

async function sendDueReminders() {
  if (running) return { skipped: true };
  running = true;
  const result = { sent: 0, failed: 0 };
  try {
    const now = Date.now();
    store.expireStaleReminders(now);
    const due = store.claimDueReminders(now, 50);
    for (const r of due) {
      const meeting = store.getMeeting(r.meeting_id);
      const contact = store.getContact(r.contact_id);
      // 連絡先の情報が変わっている可能性があるので送信直前に再判定
      const channel = store.resolveChannel(contact) || r.channel;
      const text = buildReminderText(r, meeting, contact);
      try {
        await deliver(channel, contact, text);
        store.markReminderSent(r.id, text, Date.now());
        result.sent++;
        console.log('[reminder] sent #' + r.id + ' (' + r.kind + ') via ' + channel + ' to contact ' + contact.id);
      } catch (err) {
        const retryAt = Date.now() + RETRY_DELAY_MS;
        store.markReminderFailed(r.id, describeError(err), retryAt < meeting.start_at ? retryAt : null, MAX_ATTEMPTS);
        result.failed++;
        console.error('[reminder] failed #' + r.id + ': ' + describeError(err));
      }
    }
  } finally {
    running = false;
  }
  return result;
}

module.exports = { sendDueReminders };
