// Facebook Messenger の Webhook（企業側とのやり取りを受信・記録）
const express = require('express');
const router = express.Router();
const { verifySignature, getProfileName } = require('./messengerClient');
const store = require('./reminders/store');
const { notifyConversationActivity } = require('./reminders/chatDetector');

// Webhook 登録時の検証
router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.MESSENGER_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  if (!verifySignature(req.body, req.headers['x-hub-signature-256'])) {
    return res.status(401).send('invalid signature');
  }
  const body = JSON.parse(req.body.toString('utf8'));
  res.status(200).send('EVENT_RECEIVED');
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      try {
        if (!event.message || !event.message.text) continue;
        const isEcho = Boolean(event.message.is_echo); // ページ側（当社スタッフ）が送ったメッセージ
        const psid = isEcho ? event.recipient.id : event.sender.id;
        const existing = store.findContactBy('messenger_psid', psid);
        const name = existing && existing.name ? null : await getProfileName(psid);
        store.upsertContactFromChannel('messenger', psid, name);
        store.addMessengerMessage(psid, isEcho ? 'staff' : 'user', event.message.text, event.timestamp || Date.now(), event.message.mid);
        notifyConversationActivity('messenger', psid);
      } catch (err) {
        console.error('[messenger] event handling failed: ' + err.message);
      }
    }
  }
});

module.exports = router;
