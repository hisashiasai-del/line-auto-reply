// 求人の定常運用: 掲載期限の管理・応募者の初動漏れ防止・反応のない求人の洗い出し・Slack日次報告
const axios = require('axios');
const store = require('./store');
const { generateApplicantReply } = require('./claude');

const DAY = 24 * 60 * 60 * 1000;
const APPLICANT_SLA_MS = Number(process.env.APPLICANT_SLA_HOURS || 24) * 60 * 60 * 1000;
const EXPIRY_WARN_MS = Number(process.env.JOB_EXPIRY_WARN_DAYS || 3) * DAY;
const STALE_MS = Number(process.env.JOB_STALE_DAYS || 14) * DAY;

const PLATFORM_LABEL = { site: '自社求人ページ', indeed_feed: 'Indeedフィード', indeed: 'Indeed', wantedly: 'Wantedly' };

async function notify(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('[jobs] ' + text);
    return;
  }
  try {
    await axios.post(url, { text });
  } catch (err) {
    console.error('[jobs] slack notify failed: ' + err.message);
  }
}

function checkExpiries(now) {
  const lines = [];
  for (const ch of store.getChannelsExpiringBefore(now + EXPIRY_WARN_MS)) {
    const label = PLATFORM_LABEL[ch.platform] + '「' + ch.title + '」';
    if (ch.expires_at <= now) {
      store.setChannel(ch.job_id, ch.platform, { status: 'expired' });
      lines.push('⛔ ' + label + ' の掲載期限が切れました。再掲載するか判断してください');
    } else if (!ch.expiry_notified_at) {
      store.setChannel(ch.job_id, ch.platform, { expiry_notified_at: now });
      lines.push('⏰ ' + label + ' の掲載期限は ' + new Date(ch.expires_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' です');
    }
  }
  return lines;
}

async function draftRepliesForWaitingApplicants() {
  const lines = [];
  for (const a of store.getUncontactedApplicants(APPLICANT_SLA_MS)) {
    if (!a.draft_reply && process.env.ANTHROPIC_API_KEY) {
      try {
        const draft = await generateApplicantReply(a.job_id ? store.getJob(a.job_id) : null, a);
        store.updateApplicant(a.id, { draft_reply: draft });
      } catch (err) {
        console.error('[jobs] reply draft failed for applicant ' + a.id + ': ' + err.message);
      }
    }
    const hours = Math.floor((Date.now() - a.received_at) / (60 * 60 * 1000));
    lines.push('📩 ' + (a.name || '応募者') + '（' + PLATFORM_LABEL[a.platform] + '・' + (a.job_title || '求人不明') + '）に' + hours + '時間未対応です');
  }
  return lines;
}

function findStaleJobs(now) {
  const lines = [];
  const seen = new Set();
  for (const platform of store.PLATFORMS) {
    for (const job of store.getLiveJobs(platform)) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      if (job.published_at && now - job.published_at >= STALE_MS && store.countApplicantsSince(job.id, now - STALE_MS) === 0) {
        lines.push('📉「' + job.title + '」は直近' + Math.round(STALE_MS / DAY) + '日間応募がありません。タイトルか条件の見直しを検討してください');
      }
    }
  }
  return lines;
}

async function runDailyJobOps() {
  const now = Date.now();
  const lines = [].concat(checkExpiries(now), await draftRepliesForWaitingApplicants(), findStaleJobs(now));
  const live = store.listJobs().filter((j) => j.status === 'published').length;
  const newCount = store.listApplicants({ status: 'new' }).length;
  const header = '求人運用レポート：掲載中 ' + live + '件／未対応の応募 ' + newCount + '件';
  await notify(lines.length ? header + '\n' + lines.join('\n') : header + '\n対応が必要な項目はありません');
  return { header, lines };
}

module.exports = { runDailyJobOps, notify, PLATFORM_LABEL };
