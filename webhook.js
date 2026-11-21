const express = require('express');
const router = express.Router();
const { verifySignature, getProfile } = require('./lineClient');
const { upsertConversationOnUserMessage, addMessage } = require('./db');
const { upsertContactFromChannel } = require('./reminders/store');
const { notifyConversationActivity } = require('./reminders/chatDetector');

router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send('invalid signature');
  }

  const body = JSON.parse(req.body.toString('utf8'));

  res.status(200).send('OK');

  for (const event of body.events || []) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = event.message.text;
      const timestamp = event.timestamp;
      const displayName = await getProfile(userId);
      upsertConversationOnUserMessage(userId, displayName, timestamp);
      addMessage(userId, 'user', text, timestamp);
      try {
        upsertContactFromChannel('line', userId, displayName);
        notifyConversationActivity('line', userId);
      } catch (err) {
        console.error('[line] contact/detect failed: ' + err.message);
      }
    }
  }
});

module.exports = router;
