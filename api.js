const express = require('express');
const router = express.Router();
const { pushMessage } = require('./lineClient');
const { addMessage, markReplied, saveDraft, getActionableConversations, getHistory } = require('./db');
const { generateReply } = require('./claudeClient');

router.get('/pending', (req, res) => {
  const conversations = getActionableConversations();
  const withLastMessage = conversations.map((conv) => {
    const history = getHistory(conv.line_user_id, 1);
    return {
      ...conv,
      last_message_text: history.length ? history[history.length - 1].text : '',
    };
  });
  res.json(withLastMessage);
});

router.post('/reply', async (req, res) => {
  const { lineUserId, text } = req.body;
  if (!lineUserId || !text) {
    return res.status(400).json({ error: 'lineUserId and text are required' });
  }
  try {
    await pushMessage(lineUserId, text);
    const now = Date.now();
    addMessage(lineUserId, 'staff', text, now);
    markReplied(lineUserId, now, 'replied');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/regenerate', async (req, res) => {
  const { lineUserId } = req.body;
  if (!lineUserId) {
    return res.status(400).json({ error: 'lineUserId is required' });
  }
  try {
    const history = getHistory(lineUserId, 20);
    const draftText = await generateReply(history);
    if (!draftText) {
      return res.status(500).json({ error: 'failed to generate draft' });
    }
    saveDraft(lineUserId, draftText, Date.now());
    res.json({ ok: true, draft_text: draftText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
