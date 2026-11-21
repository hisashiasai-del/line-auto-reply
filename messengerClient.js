// Facebook Messenger (Messenger Platform / Graph API) クライアント
const crypto = require('crypto');
const axios = require('axios');

const GRAPH_VERSION = process.env.MESSENGER_GRAPH_VERSION || 'v21.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;

function pageToken() {
  return process.env.MESSENGER_PAGE_ACCESS_TOKEN;
}

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.MESSENGER_APP_SECRET;
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * テキスト送信。相手の最終メッセージから24時間以内なら通常応答、
 * それ以降は Meta のメッセージタグ CONFIRMED_EVENT_UPDATE（確定済み予定のリマインド用）で送る。
 */
async function sendText(psid, text, lastUserMessageAt) {
  if (!pageToken()) throw new Error('MESSENGER_PAGE_ACCESS_TOKEN is not set');
  const withinWindow = lastUserMessageAt && Date.now() - lastUserMessageAt < STANDARD_WINDOW_MS;
  const body = withinWindow
    ? { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } }
    : { recipient: { id: psid }, messaging_type: 'MESSAGE_TAG', tag: 'CONFIRMED_EVENT_UPDATE', message: { text } };
  const res = await axios.post(GRAPH + '/me/messages', body, { params: { access_token: pageToken() } });
  return res.data;
}

async function getProfileName(psid) {
  if (!pageToken()) return null;
  try {
    const res = await axios.get(GRAPH + '/' + psid, {
      params: { fields: 'first_name,last_name,name', access_token: pageToken() },
    });
    const d = res.data || {};
    return d.name || [d.last_name, d.first_name].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

module.exports = { verifySignature, sendText, getProfileName };
