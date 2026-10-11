const { db } = require('../db');

db.exec(`
CREATE TABLE IF NOT EXISTS job_postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT,
  job_category TEXT,
  wantedly_title TEXT,
  description TEXT,
  requirements TEXT,
  employment_type TEXT,
  pay_min INTEGER,
  pay_max INTEGER,
  pay_unit TEXT,
  pay_tax TEXT,
  transport_fee TEXT,
  work_hours TEXT,
  remote TEXT DEFAULT 'none',
  postal_code TEXT,
  address_region TEXT,
  address_locality TEXT,
  address_street TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS job_channels (
  job_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off',
  external_url TEXT,
  live_at INTEGER,
  expires_at INTEGER,
  expiry_notified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, platform)
);

CREATE TABLE IF NOT EXISTS job_applicants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  platform TEXT NOT NULL,
  external_id TEXT,
  name TEXT,
  email TEXT,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  draft_reply TEXT,
  received_at INTEGER NOT NULL,
  first_contact_at INTEGER,
  UNIQUE (platform, external_id)
);
`);

const JOB_FIELDS = [
  'slug', 'status', 'title', 'job_category', 'wantedly_title', 'description', 'requirements',
  'employment_type', 'pay_min', 'pay_max', 'pay_unit', 'pay_tax', 'transport_fee', 'work_hours',
  'remote', 'postal_code', 'address_region', 'address_locality', 'address_street',
];

const PLATFORMS = ['site', 'indeed_feed', 'indeed', 'wantedly'];
const APPLICANT_STATUSES = ['new', 'contacted', 'interview', 'hired', 'rejected', 'withdrawn'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f] === '' ? null : obj[f];
  return out;
}

function listJobs() {
  return db.prepare('SELECT * FROM job_postings ORDER BY updated_at DESC').all();
}

function getJob(idOrSlug) {
  return db.prepare('SELECT * FROM job_postings WHERE id = ? OR slug = ?').get(idOrSlug, String(idOrSlug));
}

function createJob(data) {
  const now = Date.now();
  const row = pick(data, JOB_FIELDS);
  if (!row.slug) throw new Error('slug is required');
  const cols = Object.keys(row);
  const info = db.prepare(
    'INSERT INTO job_postings (' + cols.concat(['created_at', 'updated_at']).join(', ') + ') VALUES (' +
    cols.map(() => '?').concat(['?', '?']).join(', ') + ')'
  ).run(...cols.map((c) => row[c]), now, now);
  return getJob(info.lastInsertRowid);
}

function updateJob(id, data) {
  const row = pick(data, JOB_FIELDS);
  const cols = Object.keys(row);
  if (cols.length === 0) return getJob(id);
  db.prepare(
    'UPDATE job_postings SET ' + cols.map((c) => c + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?'
  ).run(...cols.map((c) => row[c]), Date.now(), id);
  return getJob(id);
}

function getChannels(jobId) {
  return db.prepare('SELECT * FROM job_channels WHERE job_id = ?').all(jobId);
}

function getChannel(jobId, platform) {
  return db.prepare('SELECT * FROM job_channels WHERE job_id = ? AND platform = ?').get(jobId, platform);
}

function setChannel(jobId, platform, fields) {
  const now = Date.now();
  const existing = getChannel(jobId, platform);
  const merged = Object.assign(
    { status: 'off', external_url: null, live_at: null, expires_at: null, expiry_notified_at: null },
    existing || {},
    fields
  );
  db.prepare(`
    INSERT INTO job_channels (job_id, platform, status, external_url, live_at, expires_at, expiry_notified_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, platform) DO UPDATE SET
      status = excluded.status, external_url = excluded.external_url, live_at = excluded.live_at,
      expires_at = excluded.expires_at, expiry_notified_at = excluded.expiry_notified_at, updated_at = excluded.updated_at
  `).run(jobId, platform, merged.status, merged.external_url, merged.live_at, merged.expires_at, merged.expiry_notified_at, now);
  syncJobStatus(jobId);
  return getChannel(jobId, platform);
}

// 掲載中チャネルが1つでもあれば published、なければ公開前の状態に戻す
function syncJobStatus(jobId) {
  const job = getJob(jobId);
  const live = getChannels(jobId).some((c) => c.status === 'live');
  if (live && job.status !== 'published') {
    db.prepare('UPDATE job_postings SET status = \'published\', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), jobId);
  } else if (!live && job.status === 'published') {
    db.prepare('UPDATE job_postings SET status = \'ready\', updated_at = ? WHERE id = ?').run(Date.now(), jobId);
  }
}

function getLiveJobs(platform) {
  return db.prepare(`
    SELECT j.* FROM job_postings j JOIN job_channels c ON c.job_id = j.id
    WHERE c.platform = ? AND c.status = 'live' ORDER BY j.published_at DESC
  `).all(platform);
}

function getChannelsExpiringBefore(timestamp) {
  return db.prepare(`
    SELECT c.*, j.title, j.slug FROM job_channels c JOIN job_postings j ON j.id = c.job_id
    WHERE c.status = 'live' AND c.expires_at IS NOT NULL AND c.expires_at <= ?
  `).all(timestamp);
}

// 重複（同じ媒体・同じ応募ID）は無視して既存行を返す
function addApplicant(data) {
  const now = Date.now();
  if (data.external_id) {
    const existing = db.prepare('SELECT * FROM job_applicants WHERE platform = ? AND external_id = ?').get(data.platform, data.external_id);
    if (existing) return { applicant: existing, duplicate: true };
  }
  const info = db.prepare(`
    INSERT INTO job_applicants (job_id, platform, external_id, name, email, phone, message, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.job_id || null, data.platform, data.external_id || null, data.name || null, data.email || null,
    data.phone || null, data.message || null, data.received_at || now);
  return { applicant: getApplicant(info.lastInsertRowid), duplicate: false };
}

function getApplicant(id) {
  return db.prepare('SELECT * FROM job_applicants WHERE id = ?').get(id);
}

function listApplicants(filter) {
  if (filter && filter.status) {
    return db.prepare('SELECT a.*, j.title AS job_title FROM job_applicants a LEFT JOIN job_postings j ON j.id = a.job_id WHERE a.status = ? ORDER BY a.received_at DESC').all(filter.status);
  }
  return db.prepare('SELECT a.*, j.title AS job_title FROM job_applicants a LEFT JOIN job_postings j ON j.id = a.job_id ORDER BY a.received_at DESC').all();
}

function updateApplicant(id, fields) {
  const allowed = pick(fields, ['status', 'draft_reply', 'first_contact_at', 'job_id']);
  if (allowed.status && !APPLICANT_STATUSES.includes(allowed.status)) throw new Error('invalid status');
  if (allowed.status && allowed.status !== 'new' && !getApplicant(id).first_contact_at) {
    allowed.first_contact_at = Date.now();
  }
  const cols = Object.keys(allowed);
  if (cols.length) {
    db.prepare('UPDATE job_applicants SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE id = ?').run(...cols.map((c) => allowed[c]), id);
  }
  return getApplicant(id);
}

function getUncontactedApplicants(olderThanMs) {
  return db.prepare(`
    SELECT a.*, j.title AS job_title FROM job_applicants a LEFT JOIN job_postings j ON j.id = a.job_id
    WHERE a.status = 'new' AND a.received_at <= ?
  `).all(Date.now() - olderThanMs);
}

function countApplicantsSince(jobId, since) {
  return db.prepare('SELECT COUNT(*) AS n FROM job_applicants WHERE job_id = ? AND received_at >= ?').get(jobId, since).n;
}

module.exports = {
  PLATFORMS,
  APPLICANT_STATUSES,
  listJobs,
  getJob,
  createJob,
  updateJob,
  getChannels,
  getChannel,
  setChannel,
  getLiveJobs,
  getChannelsExpiringBefore,
  addApplicant,
  getApplicant,
  listApplicants,
  updateApplicant,
  getUncontactedApplicants,
  countApplicantsSince,
};
