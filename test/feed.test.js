const test = require('node:test');
const assert = require('node:assert');
const feed = require('../jobs/feed');

const job = {
  id: 7, slug: 'sales', title: '法人営業', job_category: '営業', description: '新規開拓 <b>& 商談</b> ]]> 終端',
  employment_type: '業務委託', pay_min: 3000, pay_max: 4000, pay_unit: '時給', pay_tax: '税別', remote: 'none',
  address_region: '東京都', address_locality: '渋谷区', address_street: '道玄坂1-2-3', updated_at: Date.UTC(2026, 9, 1), published_at: Date.UTC(2026, 9, 2),
};

test('pay is formatted with tax label', () => {
  assert.strictEqual(feed.formatPay(job), '時給 3,000円〜4,000円（税別）');
});

test('indeed xml escapes CDATA terminators and includes required tags', () => {
  const xml = feed.indeedXml([job]);
  for (const tag of ['title', 'date', 'referencenumber', 'url', 'company', 'city', 'state', 'country', 'description', 'salary', 'jobtype']) {
    assert.ok(xml.includes('<' + tag + '>'), tag);
  }
  assert.ok(!xml.includes('<![CDATA[新規開拓 <b>& 商談</b> ]]> 終端'));
  assert.strictEqual(xml.split('<![CDATA[').length, xml.split(']]>').length);
});

test('job page embeds valid JSON-LD and escapes HTML', () => {
  const html = feed.careersJobHtml(Object.assign({}, job, { title: '<script>alert(1)</script>' }), Date.UTC(2026, 10, 1));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/);
  const ld = JSON.parse(m[1]);
  assert.strictEqual(ld['@type'], 'JobPosting');
  assert.strictEqual(ld.employmentType, 'CONTRACTOR');
  assert.strictEqual(ld.baseSalary.value.unitText, 'HOUR');
  assert.strictEqual(ld.jobLocation.address.addressLocality, '渋谷区');
  assert.ok(ld.validThrough.startsWith('2026-11-01'));
});

test('wantedly kit keeps pay out of the body', () => {
  const kit = feed.postingKit(Object.assign({}, job, { description: '新規開拓をお任せします', wantedly_title: '営業メンバー募集' }), 'wantedly');
  const body = kit.fields.find(([k]) => k.includes('本文'))[1];
  assert.ok(!body.includes('円'));
  assert.ok(kit.fields.find(([k]) => k.includes('募集条件'))[1].includes('3,000円'));
});
