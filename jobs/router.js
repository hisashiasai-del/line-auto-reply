const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const { validateJob } = require('./policy');
const feed = require('./feed');
const { generateJobDraft, generateApplicantReply } = require('./claude');
const { runDailyJobOps, notify, PLATFORM_LABEL } = require('./ops');

const DAY = 24 * 60 * 60 * 1000;
const WANTEDLY_DEFAULT_DAYS = Number(process.env.WANTEDLY_DEFAULT_DAYS || 30);
const MANUAL_PLATFORMS = ['indeed', 'wantedly'];

function withDetails(job) {
  const validation = {};
  for (const p of store.PLATFORMS) validation[p] = validateJob(job, p);
  return Object.assign({}, job, { channels: store.getChannels(job.id), validation });
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((err) => res.status(500).json({ error: err.message }));
}

function loadJob(req, res) {
  const job = store.getJob(req.params.id);
  if (!job) res.status(404).json({ error: 'job not found' });
  return job;
}

// ---- 管理API（/api/recruit） ----
const admin = express.Router();

admin.get('/jobs', (req, res) => res.json(store.listJobs().map(withDetails)));

admin.post('/jobs', (req, res) => {
  try {
    res.json(withDetails(store.createJob(req.body)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.get('/jobs/:id', (req, res) => {
  const job = loadJob(req, res);
  if (job) res.json(withDetails(job));
});

admin.patch('/jobs/:id', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const updated = store.updateJob(job.id, Object.assign({}, req.body, { status: undefined, slug: undefined }));
  // 掲載中の内容を変えたら、手動媒体は貼り直しが必要なことを返す
  const needsRepost = store.getChannels(job.id).filter((c) => MANUAL_PLATFORMS.includes(c.platform) && c.status === 'live').map((c) => c.platform);
  res.json(Object.assign(withDetails(updated), { needs_repost: needsRepost }));
});

admin.post('/jobs/:id/draft', asyncRoute(async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const draft = await generateJobDraft(job, req.body && req.body.instructions);
  // 下書きは保存せず返す。採用するかは画面で人が決める
  res.json({ draft, validation: validateJob(Object.assign({}, job, draft), 'wantedly') });
}));

admin.get('/jobs/:id/kit/:platform', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (!MANUAL_PLATFORMS.includes(req.params.platform)) return res.status(400).json({ error: 'kit is for indeed / wantedly' });
  res.json(Object.assign(feed.postingKit(job, req.params.platform), { validation: validateJob(job, req.params.platform) }));
});

admin.post('/jobs/:id/channels/:platform', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const platform = req.params.platform;
  if (!store.PLATFORMS.includes(platform)) return res.status(400).json({ error: 'unknown platform' });
  const action = (req.body && req.body.action) || 'enable';
  const now = Date.now();

  if (action === 'disable') {
    store.setChannel(job.id, platform, { status: 'off' });
    return res.json(withDetails(store.getJob(job.id)));
  }

  const validation = validateJob(job, platform);
  if (!validation.ok) return res.status(422).json({ error: '掲載前チェックでエラーがあります', validation });

  if (action === 'enable' && !MANUAL_PLATFORMS.includes(platform)) {
    // indeed_feed の求人URLは自社求人ページを指すため、ページも同時に公開する
    if (platform === 'indeed_feed') store.setChannel(job.id, 'site', { status: 'live', live_at: now });
    store.setChannel(job.id, platform, { status: 'live', live_at: now });
    return res.json(withDetails(store.getJob(job.id)));
  }

  if (action === 'enable') {
    store.setChannel(job.id, platform, { status: 'pending_manual' });
    return res.json(Object.assign(withDetails(store.getJob(job.id)), { kit: feed.postingKit(job, platform) }));
  }

  if (action === 'confirm' && MANUAL_PLATFORMS.includes(platform)) {
    const externalUrl = req.body.external_url;
    if (!externalUrl || !/^https:\/\//.test(externalUrl)) return res.status(400).json({ error: '公開後の求人URL（https://〜）を入力してください' });
    let days = req.body.expires_in_days;
    if (days === undefined || days === null || days === '') days = platform === 'wantedly' ? WANTEDLY_DEFAULT_DAYS : null;
    store.setChannel(job.id, platform, {
      status: 'live',
      external_url: externalUrl,
      live_at: now,
      expires_at: days ? now + Number(days) * DAY : null,
      expiry_notified_at: null,
    });
    return res.json(withDetails(store.getJob(job.id)));
  }

  res.status(400).json({ error: 'unknown action' });
});

admin.get('/applicants', (req, res) => res.json(store.listApplicants({ status: req.query.status })));

admin.patch('/applicants/:id', (req, res) => {
  if (!store.getApplicant(req.params.id)) return res.status(404).json({ error: 'applicant not found' });
  try {
    res.json(store.updateApplicant(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.post('/applicants/:id/draft', asyncRoute(async (req, res) => {
  const applicant = store.getApplicant(req.params.id);
  if (!applicant) return res.status(404).json({ error: 'applicant not found' });
  const draft = await generateApplicantReply(applicant.job_id ? store.getJob(applicant.job_id) : null, applicant);
  res.json(store.updateApplicant(applicant.id, { draft_reply: draft }));
}));

admin.post('/ops/run', asyncRoute(async (req, res) => res.json(await runDailyJobOps())));

// ---- 応募の取り込み（Make / Gmail 連携から Indeed・Wantedly の応募通知を転送する） ----
const intake = express.Router();

function tokenOk(given) {
  const expected = process.env.INTAKE_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

intake.post('/applicants', asyncRoute(async (req, res) => {
  if (!tokenOk(req.headers['x-intake-token'])) return res.status(401).json({ error: 'invalid token' });
  const body = req.body || {};
  if (!store.PLATFORMS.includes(body.platform)) return res.status(400).json({ error: 'platform must be one of ' + store.PLATFORMS.join(', ') });
  const job = body.job ? store.getJob(body.job) : null;
  const { applicant, duplicate } = store.addApplicant(Object.assign({}, body, { job_id: job ? job.id : null }));
  if (!duplicate) await notify('🆕 ' + PLATFORM_LABEL[body.platform] + ' から応募：' + (applicant.name || '名前不明') + '（' + (job ? job.title : '求人不明') + '）');
  res.json({ applicant, duplicate });
}));

// ---- 公開ページ（自社求人ページ・Indeed XMLフィード） ----
const site = express.Router();

function siteLiveJob(slug) {
  const job = store.getJob(slug);
  if (!job) return null;
  const ch = store.getChannel(job.id, 'site');
  if (!ch || ch.status !== 'live' || !validateJob(job, 'site').ok) return null;
  return { job, channel: ch };
}

site.get('/careers', (req, res) => res.type('html').send(feed.careersIndexHtml(store.getLiveJobs('site'))));

site.get('/careers/:slug', (req, res) => {
  const found = siteLiveJob(req.params.slug);
  if (!found) return res.status(404).type('html').send('<p>この求人は現在募集していません。</p>');
  res.type('html').send(feed.careersJobHtml(found.job, found.channel.expires_at));
});

site.post('/careers/:slug/apply', express.urlencoded({ extended: false, limit: '20kb' }), asyncRoute(async (req, res) => {
  const found = siteLiveJob(req.params.slug);
  if (!found) return res.status(404).type('html').send('<p>この求人は現在募集していません。</p>');
  const b = req.body || {};
  // 隠し項目に入力があるものはボットとみなして受け付けたふりをする
  if (b.company) return res.type('html').send(feed.careersJobHtml(found.job, found.channel.expires_at, 'ご応募ありがとうございました。'));
  if (!b.name || !b.email) return res.status(400).type('html').send(feed.careersJobHtml(found.job, found.channel.expires_at, 'お名前とメールアドレスを入力してください。'));
  const { applicant } = store.addApplicant({
    job_id: found.job.id,
    platform: 'site',
    name: String(b.name).slice(0, 100),
    email: String(b.email).slice(0, 200),
    phone: b.phone ? String(b.phone).slice(0, 30) : null,
    message: b.message ? String(b.message).slice(0, 4000) : null,
  });
  await notify('🆕 自社求人ページから応募：' + applicant.name + '（' + found.job.title + '）');
  res.type('html').send(feed.careersJobHtml(found.job, found.channel.expires_at, 'ご応募ありがとうございました。担当者よりご連絡いたします。'));
}));

site.get('/feeds/indeed.xml', (req, res) => {
  const jobs = store.getLiveJobs('indeed_feed').filter((j) => validateJob(j, 'indeed_feed').ok);
  res.type('application/xml').send(feed.indeedXml(jobs));
});

module.exports = { admin, intake, site };
