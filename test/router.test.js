process.env.DB_PATH = ':memory:';
process.env.INTAKE_TOKEN = 'secret-token';
delete process.env.SLACK_WEBHOOK_URL;
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jobs = require('../jobs/router');
const store = require('../jobs/store');
const { complete } = require('./fixtures');

let base;
let server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/recruit', jobs.admin);
  app.use('/api/intake', jobs.intake);
  app.use('/', jobs.site);
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

async function call(method, path, body, headers) {
  const res = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test('full posting and operations flow', async () => {
  const incomplete = Object.assign({}, complete, { slug: 'sales', address_street: null });
  const created = await call('POST', '/api/recruit/jobs', incomplete);
  assert.strictEqual(created.status, 200);
  const id = created.data.id;

  // 住所が未確定のうちは公開できない
  const blocked = await call('POST', '/api/recruit/jobs/' + id + '/channels/indeed_feed', { action: 'enable' });
  assert.strictEqual(blocked.status, 422);
  assert.strictEqual((await call('GET', '/careers/sales')).status, 404);

  await call('PATCH', '/api/recruit/jobs/' + id, { address_street: '道玄坂1-2-3' });

  // 自動掲載: フィードを有効にすると自社ページも公開される
  const feedOn = await call('POST', '/api/recruit/jobs/' + id + '/channels/indeed_feed', { action: 'enable' });
  assert.strictEqual(feedOn.status, 200);
  assert.strictEqual(feedOn.data.status, 'published');
  assert.ok(feedOn.data.channels.find((c) => c.platform === 'site').status === 'live');
  const xml = await call('GET', '/feeds/indeed.xml');
  assert.ok(xml.data.includes('法人営業'));
  const page = await call('GET', '/careers/sales');
  assert.ok(page.data.includes('application/ld+json'));

  // 手動媒体: 掲載キット → 公開URL登録 → 期限管理
  const kit = await call('POST', '/api/recruit/jobs/' + id + '/channels/wantedly', { action: 'enable' });
  assert.strictEqual(kit.data.channels.find((c) => c.platform === 'wantedly').status, 'pending_manual');
  assert.ok(kit.data.kit.fields.length > 0);
  const bad = await call('POST', '/api/recruit/jobs/' + id + '/channels/wantedly', { action: 'confirm', external_url: 'javascript:alert(1)' });
  assert.strictEqual(bad.status, 400);
  const confirmed = await call('POST', '/api/recruit/jobs/' + id + '/channels/wantedly', { action: 'confirm', external_url: 'https://www.wantedly.com/projects/1' });
  const wch = confirmed.data.channels.find((c) => c.platform === 'wantedly');
  assert.strictEqual(wch.status, 'live');
  assert.ok(Math.abs(wch.expires_at - Date.now() - 30 * 86400000) < 60000);

  // 応募の取り込み（トークン必須・重複は無視）
  const noToken = await call('POST', '/api/intake/applicants', { platform: 'indeed', name: 'A' });
  assert.strictEqual(noToken.status, 401);
  const payload = { platform: 'indeed', external_id: 'abc', job: 'sales', name: '山田', email: 'y@example.com' };
  const first = await call('POST', '/api/intake/applicants', payload, { 'x-intake-token': 'secret-token' });
  assert.strictEqual(first.data.duplicate, false);
  assert.strictEqual(first.data.applicant.job_id, id);
  const again = await call('POST', '/api/intake/applicants', payload, { 'x-intake-token': 'secret-token' });
  assert.strictEqual(again.data.duplicate, true);

  // 自社ページからの応募（ボット用の隠し項目が埋まっていれば保存しない）
  const form = (body) => fetch(base + '/careers/sales/apply', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  await form({ name: 'bot', email: 'b@example.com', company: 'spam' });
  await form({ name: '佐藤', email: 's@example.com', message: '営業経験5年です' });
  const applicants = (await call('GET', '/api/recruit/applicants')).data;
  assert.deepStrictEqual(applicants.map((a) => a.name).sort(), ['佐藤', '山田']);

  // 日次運用: 期限切れの検知と未対応応募の検知
  store.setChannel(id, 'wantedly', { expires_at: Date.now() - 1000 });
  store.updateApplicant(first.data.applicant.id, {});
  require('../db').db.prepare('UPDATE job_applicants SET received_at = ? WHERE id = ?').run(Date.now() - 2 * 86400000, first.data.applicant.id);
  const ops = await call('POST', '/api/recruit/ops/run');
  assert.ok(ops.data.lines.some((l) => l.includes('Wantedly') && l.includes('期限が切れました')));
  assert.ok(ops.data.lines.some((l) => l.includes('山田') && l.includes('未対応')));
  assert.strictEqual(store.getChannel(id, 'wantedly').status, 'expired');

  // 状態を進めると初回対応日時が入る
  const contacted = await call('PATCH', '/api/recruit/applicants/' + first.data.applicant.id, { status: 'contacted' });
  assert.ok(contacted.data.first_contact_at);

  // 全チャネル停止で未公開に戻り、ページとフィードから消える
  for (const p of ['site', 'indeed_feed']) await call('POST', '/api/recruit/jobs/' + id + '/channels/' + p, { action: 'disable' });
  assert.strictEqual((await call('GET', '/api/recruit/jobs/' + id)).data.status, 'ready');
  assert.strictEqual((await call('GET', '/careers/sales')).status, 404);
  assert.ok(!(await call('GET', '/feeds/indeed.xml')).data.includes('法人営業'));
});
