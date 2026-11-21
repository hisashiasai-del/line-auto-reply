// LINE / Messenger のやり取りから面談の確定・変更・キャンセルを検知して面談データに反映する
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const store = require('./store');
const { getHistory } = require('../db');
const { formatJst, parseJstLocal } = require('./time');

const MODEL = process.env.MEETING_DETECT_MODEL || 'claude-opus-5-5';
const DEBOUNCE_MS = Number(process.env.MEETING_DETECT_DEBOUNCE_SECONDS || 90) * 1000;
// 日程に関係しそうな語が直近のメッセージに無ければ、API を呼ばずに済ませる
const SCHEDULE_HINT = /(\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*[:：時]|明日|明後日|あさって|来週|今週|再来週|[月火水木金土日]曜|面談|面接|三者|打ち合わせ|打合せ|ミーティング|MTG|日程|日時|予定|キャンセル|変更|延期|リスケ)/i;

const DetectionSchema = z.object({
  meetings: z.array(
    z.object({
      status: z.enum(['confirmed', 'tentative', 'cancelled']),
      start_at_jst: z.string().describe('面談開始日時 (JST) を YYYY-MM-DDTHH:mm 形式で'),
      previous_start_at_jst: z.string().nullable().describe('日程変更の場合、変更前の開始日時 (YYYY-MM-DDTHH:mm)。無ければ null'),
      meeting_type: z.string().describe('例: 三者面談, 面接, 面談, 打ち合わせ'),
      title: z.string().describe('リマインドに載せる短い件名'),
      location_or_url: z.string().nullable(),
      counterpart_names: z.array(z.string()).describe('同席する他の人物・企業名（会話に出ていれば）'),
    })
  ),
});

const SYSTEM_PROMPT = [
  'あなたは人材紹介会社のアシスタントです。フリーランス人材または企業担当者とのチャット履歴を読み、',
  '面談・面接・三者面談・打ち合わせなどの予定を抽出してください。',
  '',
  '- status は、双方が日時に合意済みなら confirmed、候補日の提示や調整中なら tentative、中止になったなら cancelled。',
  '- 「明日」「来週火曜」などの相対表現は、与えられた現在日時 (JST) を基準に具体的な日時へ直してください。',
  '- 日程が変更された場合は、新しい日時を start_at_jst に、変更前の日時を previous_start_at_jst に入れてください。',
  '- 時刻が特定できない予定、すでに終わった予定は含めないでください。',
  '- 予定が無ければ meetings は空配列にしてください。',
].join('\n');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function formatHistory(history, channel) {
  const other = channel === 'line' ? '相手(フリーランス)' : '相手(企業)';
  return history
    .map((m) => '[' + formatJst(m.created_at).iso + '] ' + (m.sender === 'user' ? other : '当社スタッフ') + ': ' + m.text)
    .join('\n');
}

async function extractMeetings(history, channel, contact, now) {
  const nowJst = formatJst(now);
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(DetectionSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          '現在日時 (JST): ' + nowJst.iso + ' ' + nowJst.date + '\n' +
          '相手: ' + (contact.name || '不明') + (contact.company_name ? '（' + contact.company_name + '）' : '') + '\n\n' +
          '<chat>\n' + formatHistory(history, channel) + '\n</chat>',
      },
    ],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return [];
  return response.parsed_output.meetings;
}

function namesMatch(meeting, counterpartNames) {
  if (!counterpartNames || !counterpartNames.length) return false;
  const haystack = [meeting.title, ...store.getParticipants(meeting.id).flatMap((p) => [p.name, p.company_name])]
    .filter(Boolean)
    .join(' ')
    .replace(/\s/g, '');
  return counterpartNames.some((n) => {
    const k = String(n).replace(/\s|様|さん|株式会社|\(株\)|（株）/g, '');
    return k.length >= 2 && haystack.includes(k);
  });
}

/**
 * 抽出結果を面談データへ反映（API 呼び出しと分離してテスト可能にしている）
 *  - 同じ相手・同じ日時の面談が既にあれば更新
 *  - 同時刻に別経路（カレンダー/DB/もう一方のチャット）で登録済みの面談があれば参加者として合流
 *    （三者面談で企業側とフリーランス側の予定が1件にまとまる）
 *  - 無ければチャット由来の面談として新規作成
 */
function applyDetections(contact, channel, detections, now) {
  const results = [];
  for (const d of detections) {
    const startAt = parseJstLocal(d.start_at_jst);
    if (!startAt || startAt <= now) continue;
    const prevAt = d.previous_start_at_jst ? parseJstLocal(d.previous_start_at_jst) : null;

    if (d.status === 'cancelled') {
      const m = store.findMeetingForContactAt(contact.id, startAt);
      if (m) {
        cancelForContact(m, contact, channel);
        results.push({ action: 'cancelled', meetingId: m.id });
      }
      continue;
    }
    if (d.status !== 'confirmed') continue;

    // 日程変更: 旧日時の面談から外す（チャット由来なら面談そのものを移動）
    if (prevAt && prevAt !== startAt) {
      const old = store.findMeetingForContactAt(contact.id, prevAt);
      if (old) {
        if (old.source === channel && !store.findMeetingForContactAt(contact.id, startAt)) {
          store.updateMeeting(old.id, { startAt, location: d.location_or_url || old.location });
          results.push({ action: 'rescheduled', meetingId: old.id });
          continue;
        }
        cancelForContact(old, contact, channel);
      }
    }

    const own = store.findMeetingForContactAt(contact.id, startAt);
    if (own) {
      if (d.location_or_url && !own.location) store.updateMeeting(own.id, { location: d.location_or_url });
      results.push({ action: 'unchanged', meetingId: own.id });
      continue;
    }

    const sameTime = store.findScheduledMeetingsAt(startAt);
    // 名前が一致する面談を優先。無ければ「同時刻に1件だけ、かつ相手側（企業⇔フリーランス）しか参加していない」面談に合流
    const complementary = (m) => store.getParticipants(m.id).every((p) => p.kind !== contact.kind);
    const target =
      sameTime.find((m) => namesMatch(m, d.counterpart_names)) ||
      (sameTime.length === 1 && complementary(sameTime[0]) ? sameTime[0] : null);
    if (target) {
      store.addParticipant(target.id, contact.id, channel);
      if (d.location_or_url && !target.location) store.updateMeeting(target.id, { location: d.location_or_url });
      else store.syncRemindersForMeeting(target.id);
      results.push({ action: 'joined', meetingId: target.id });
      continue;
    }

    const created = store.createMeeting({
      title: d.title || d.meeting_type || '面談',
      meetingType: d.meeting_type,
      startAt,
      location: d.location_or_url,
      source: channel,
      participantIds: [contact.id],
      addedBy: channel,
    });
    results.push({ action: 'created', meetingId: created.id });
  }
  return results;
}

// チャット由来の面談ならキャンセル、カレンダー/DB の面談ならその人を参加者から外すだけ
// （カレンダーが正なので、カレンダー側の予定は担当者が更新する想定）
function cancelForContact(meeting, contact, channel) {
  const participants = store.getParticipants(meeting.id);
  if (meeting.source === channel && participants.length <= 1) {
    store.updateMeeting(meeting.id, { status: 'cancelled' });
  } else {
    store.removeParticipant(meeting.id, contact.id);
  }
}

function loadHistory(channel, channelId) {
  return channel === 'line' ? getHistory(channelId, 30) : store.getMessengerHistory(channelId, 30);
}

async function detectForConversation(channel, channelId) {
  const contact = store.findContactBy(channel === 'line' ? 'line_user_id' : 'messenger_psid', channelId);
  if (!contact) return [];
  const history = loadHistory(channel, channelId);
  if (!history.length) return [];
  const recent = history.slice(-5).map((m) => m.text).join('\n');
  if (!SCHEDULE_HINT.test(recent)) return [];
  const now = Date.now();
  const detections = await extractMeetings(history, channel, contact, now);
  const results = applyDetections(contact, channel, detections, now);
  if (results.length) console.log('[detector] ' + channel + ' contact ' + contact.id + ': ' + JSON.stringify(results));
  return results;
}

// メッセージが続けて届くことが多いので、会話ごとに少し待ってからまとめて解析する
const timers = new Map();
function notifyConversationActivity(channel, channelId) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return;
  const key = channel + ':' + channelId;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      detectForConversation(channel, channelId).catch((err) =>
        console.error('[detector] ' + key + ' failed: ' + (err && err.message))
      );
    }, DEBOUNCE_MS)
  );
}

module.exports = { notifyConversationActivity, detectForConversation, applyDetections, extractMeetings };
