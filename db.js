const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT DEFAULT 'pending',
  last_user_message_at INTEGER,
  last_reply_at INTEGER,
  draft_text TEXT,
  draft_created_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

function upsertConversationOnUserMessage(lineUserId, displayName, timestamp) {
  const existing = db.prepare('SELECT * FROM conversations WHERE line_user_id = ?').get(lineUserId);
  if (existing) {
    db.prepare('UPDATE conversations SET status = \'pending\', last_user_message_at = ?, display_name = ? WHERE line_user_id = ?').run(timestamp, displayName || existing.display_name, lineUserId);
  } else {
    db.prepare('INSERT INTO conversations (line_user_id, display_name, status, last_user_message_at) VALUES (?, ?, \'pending\', ?)').run(lineUserId, displayName, timestamp);
  }
}

function addMessage(lineUserId, sender, text, timestamp) {
  db.prepare('INSERT INTO messages (line_user_id, sender, text, created_at) VALUES (?, ?, ?, ?)').run(lineUserId, sender, text, timestamp);
}

function markReplied(lineUserId, timestamp, status) {
  if (!status) status = 'replied';
  db.prepare('UPDATE conversations SET status = ?, last_reply_at = ?, draft_text = NULL, draft_created_at = NULL WHERE line_user_id = ?').run(status, timestamp, lineUserId);
}

function saveDraft(lineUserId, draftText, timestamp) {
  db.prepare('UPDATE conversations SET status = \'draft_ready\', draft_text = ?, draft_created_at = ? WHERE line_user_id = ?').run(draftText, timestamp, lineUserId);
}

function getPendingConversations(thresholdMs) {
  const cutoff = Date.now() - thresholdMs;
  return db.prepare('SELECT * FROM conversations WHERE status = \'pending\' AND last_user_message_at <= ?').all(cutoff);
}

function getActionableConversations() {
  return db.prepare('SELECT * FROM conversations WHERE status IN (\'pending\', \'draft_ready\') ORDER BY last_user_message_at ASC').all();
}

function getHistory(lineUserId, limit) {
  if (!limit) limit = 20;
  return db.prepare('SELECT sender, text, created_at FROM messages WHERE line_user_id = ? ORDER BY created_at DESC LIMIT ?').all(lineUserId, limit).reverse();
}

module.exports = {
  db,
  upsertConversationOnUserMessage,
  addMessage,
  markReplied,
  saveDraft,
  getPendingConversations,
  getActionableConversations,
  getHistory,
};
