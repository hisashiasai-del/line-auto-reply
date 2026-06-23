const cron = require('node-cron');
const { getPendingConversations, getHistory, saveDraft } = require('./db');
const { generateReply } = require('./claudeClient');

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

function startScheduler() {
  cron.schedule('*/5 * * * *', checkAndGenerateDrafts);
  console.log('Scheduler started');
}

module.exports = { startScheduler, checkAndGenerateDrafts };
