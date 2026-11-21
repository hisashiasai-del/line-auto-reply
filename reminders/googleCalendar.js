// Google カレンダーから面談予定を取り込む
// 認証: OAuth クライアント + リフレッシュトークン（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN）
const axios = require('axios');
const store = require('./store');

const KEYWORDS = new RegExp(process.env.GOOGLE_CALENDAR_KEYWORDS || '面談|面接|三者|顔合わせ|打ち合わせ|打合せ|MTG|ミーティング', 'i');
const LOOKAHEAD_DAYS = Number(process.env.GOOGLE_CALENDAR_LOOKAHEAD_DAYS || 14);

let cachedToken = null;

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60 * 1000) return cachedToken.token;
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  cachedToken = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return cachedToken.token;
}

async function listEvents(calendarId, timeMin, timeMax) {
  const token = await getAccessToken();
  const items = [];
  let pageToken;
  do {
    const res = await axios.get(
      'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events',
      {
        headers: { Authorization: 'Bearer ' + token },
        params: {
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
          singleEvents: true,
          showDeleted: true,
          orderBy: 'startTime',
          maxResults: 250,
          pageToken,
        },
      }
    );
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

// 参加者メール、またはタイトル/説明文に含まれる名前から連絡先を特定
function matchContacts(event, contacts) {
  const ids = new Set();
  const emails = (event.attendees || []).map((a) => String(a.email || '').toLowerCase());
  const text = [event.summary, event.description].filter(Boolean).join('\n');
  for (const c of contacts) {
    if (c.email && emails.includes(c.email)) ids.add(c.id);
    else if (c.name && c.name.replace(/\s/g, '').length >= 2 && text.replace(/\s/g, '').includes(c.name.replace(/\s/g, ''))) ids.add(c.id);
    else if (c.kind === 'company' && c.company_name && c.company_name.length >= 2 && text.includes(c.company_name)) ids.add(c.id);
  }
  return [...ids];
}

function eventToMeetingFields(event) {
  return {
    title: event.summary || '面談',
    startAt: Date.parse(event.start.dateTime),
    endAt: event.end && event.end.dateTime ? Date.parse(event.end.dateTime) : null,
    location: event.hangoutLink || event.location || null,
  };
}

async function syncCalendar() {
  if (!isConfigured()) return { skipped: 'not configured' };
  const calendarIds = (process.env.GOOGLE_CALENDAR_IDS || 'primary').split(',').map((s) => s.trim()).filter(Boolean);
  const now = Date.now();
  const contacts = store.listContacts();
  const summary = { created: 0, updated: 0, cancelled: 0 };

  for (const calendarId of calendarIds) {
    const events = await listEvents(calendarId, now, now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    for (const event of events) {
      const externalId = 'gcal:' + calendarId + ':' + event.id;
      const existing = store.findMeetingByExternalId(externalId);

      if (event.status === 'cancelled') {
        if (existing && existing.status !== 'cancelled') {
          store.updateMeeting(existing.id, { status: 'cancelled' });
          summary.cancelled++;
        }
        continue;
      }
      if (!event.start || !event.start.dateTime) continue; // 終日予定は対象外

      const participantIds = matchContacts(event, contacts);
      const relevant = KEYWORDS.test(event.summary || '') || participantIds.length > 0;
      if (!relevant) continue;

      const fields = eventToMeetingFields(event);
      if (existing) {
        store.updateMeeting(existing.id, { ...fields, status: 'scheduled' });
        for (const cid of participantIds) store.addParticipant(existing.id, cid, 'google_calendar');
        store.syncRemindersForMeeting(existing.id);
        summary.updated++;
      } else {
        // チャットから先に検知済みの同時刻の面談があれば、カレンダーの予定として統合する
        const chatDetected = participantIds
          .map((cid) => store.findMeetingForContactAt(cid, fields.startAt))
          .find((m) => m && !m.external_id);
        if (chatDetected) {
          store.updateMeeting(chatDetected.id, { title: fields.title, endAt: fields.endAt, location: fields.location || chatDetected.location });
          store.setMeetingSource(chatDetected.id, 'google_calendar', externalId);
          for (const cid of participantIds) store.addParticipant(chatDetected.id, cid, 'google_calendar');
          store.syncRemindersForMeeting(chatDetected.id);
          summary.updated++;
        } else {
          store.createMeeting({ ...fields, source: 'google_calendar', externalId, participantIds, addedBy: 'google_calendar' });
          summary.created++;
        }
      }
    }
  }
  return summary;
}

module.exports = { syncCalendar, isConfigured, matchContacts };
