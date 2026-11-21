const cron = require('node-cron');
const { getPendingConversations, getHistory, saveDraft } = require('./db');
const { generateReply } = require('./claudeClient');
const { sendDueReminders } = require('./reminders/sender');
const { syncCalendar, isConfigured: calendarConfigured } = require('./reminders/googleCalendar');
const { resetStuckReminders } = require('./reminders/store');

const REPLY_THRESHOLD_MS = Number(process.env.REPLY_THRESHOLD_MINUTES || 60) * 60 * 1000;

async function checkAndGenerateDrafts() {
  const pending = getPendingConversations(REPLY_THRESHOLD_MS);
  for (const conv of pending) {
    try {
      const history = getHistory(conv.line_user_id, 20);
      if (history.length === 0) continue;
      const draftText = await generateReply(history);
      if (!draftText) continue;
      saveDraft(conv.line_user_id, draftText, Date.now());
      console.log('draft generated for ' + conv.line_user_id);
    } catch (err) {
      console.error('draft failed for ' + conv.line_user_id + ': ' + err.message);
    }
  }
}

async function runCalendarSync() {
  try {
    const r = await syncCalendar();
    if (r && !r.skipped && (r.created || r.updated || r.cancelled)) console.log('[calendar] ' + JSON.stringify(r));
  } catch (err) {
    console.error('[calendar] sync failed: ' + err.message);
  }
}

async function runReminders() {
  try {
    await sendDueReminders();
  } catch (err) {
    console.error('[reminder] run failed: ' + err.message);
  }
}

function startScheduler() {
  cron.schedule('*/5 * * * *', checkAndGenerateDrafts);
  // リマインド: 毎分、送信時刻を過ぎたものを自動送信（前日12:00 / 当日9:00 JST）
  resetStuckReminders();
  cron.schedule('* * * * *', runReminders);
  // Google カレンダー: 10分ごとに面談予定を取り込み
  if (calendarConfigured()) {
    cron.schedule('*/10 * * * *', runCalendarSync);
    runCalendarSync();
  }
  console.log('Scheduler started');
}

module.exports = { startScheduler, checkAndGenerateDrafts };
