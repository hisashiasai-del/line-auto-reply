const crypto = require('crypto');
const axios = require('axios');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  return hash === signature;
}

async function pushMessage(to, text) {
  return axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text }] },
    { headers: { Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN } }
  );
}

async function getProfile(userId) {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    });
    return res.data.displayName;
  } catch {
    return null;
  }
}

module.exports = { verifySignature, pushMessage, getProfile };
