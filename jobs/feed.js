// 求人データを各媒体の形式へ変換する（Indeed XMLフィード / Google しごと検索用 JSON-LD / 求人ページ / 手動掲載キット）

const COMPANY_NAME = process.env.COMPANY_NAME || 'LIS';
const COMPANY_URL = process.env.COMPANY_URL || '';

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');
}

function jobUrl(job) {
  return baseUrl() + '/careers/' + encodeURIComponent(job.slug);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cdata(s) {
  return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

function formatYen(n) {
  return Number(n).toLocaleString('ja-JP') + '円';
}

function formatPay(job) {
  if (job.pay_min == null) return '';
  const range = job.pay_max ? formatYen(job.pay_min) + '〜' + formatYen(job.pay_max) : formatYen(job.pay_min) + '〜';
  return job.pay_unit + ' ' + range + (job.pay_tax ? '（' + job.pay_tax + '）' : '');
}

function formatAddress(job) {
  return [job.postal_code ? '〒' + job.postal_code : '', job.address_region, job.address_locality, job.address_street]
    .filter(Boolean).join(' ');
}

function conditionLines(job) {
  return [
    ['契約形態', job.employment_type],
    ['報酬', formatPay(job)],
    ['交通費', job.transport_fee],
    ['稼働', job.work_hours],
    ['勤務地', formatAddress(job)],
    ['リモート', { none: 'なし（出社）', partial: '一部リモート可', full: 'フルリモート' }[job.remote]],
  ].filter(([, v]) => v);
}

function fullDescriptionText(job) {
  const parts = [job.description];
  if (job.requirements) parts.push('【歓迎する経験】\n' + job.requirements);
  parts.push('【募集条件】\n' + conditionLines(job).map(([k, v]) => k + '：' + v).join('\n'));
  return parts.filter(Boolean).join('\n\n');
}

function textToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

const SCHEMA_EMPLOYMENT = {
  '業務委託': 'CONTRACTOR', '正社員': 'FULL_TIME', '契約社員': 'TEMPORARY',
  'アルバイト': 'PART_TIME', 'パート': 'PART_TIME', 'インターン': 'INTERN',
};
const SCHEMA_UNIT = { '時給': 'HOUR', '月給': 'MONTH', '年収': 'YEAR' };

function jobPostingJsonLd(job, validThrough) {
  const value = { '@type': 'QuantitativeValue', minValue: job.pay_min, unitText: SCHEMA_UNIT[job.pay_unit] };
  if (job.pay_max) value.maxValue = job.pay_max;
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description: textToHtml(fullDescriptionText(job)),
    datePosted: new Date(job.published_at || job.updated_at).toISOString().slice(0, 10),
    employmentType: SCHEMA_EMPLOYMENT[job.employment_type] || 'OTHER',
    hiringOrganization: Object.assign({ '@type': 'Organization', name: COMPANY_NAME }, COMPANY_URL ? { sameAs: COMPANY_URL } : {}),
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: job.address_street,
        addressLocality: job.address_locality,
        addressRegion: job.address_region,
        postalCode: job.postal_code || undefined,
        addressCountry: 'JP',
      },
    },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'JPY', value },
    directApply: true,
  };
  if (job.remote === 'full') {
    ld.jobLocationType = 'TELECOMMUTE';
    ld.applicantLocationRequirements = { '@type': 'Country', name: 'JP' };
  }
  if (validThrough) ld.validThrough = new Date(validThrough).toISOString();
  // JSON-LD を <script> に埋め込むため </script> を壊さないようにする
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

function indeedXml(jobs) {
  const items = jobs.map((job) => [
    '<job>',
    '<title>' + cdata(job.title) + '</title>',
    '<date>' + cdata(new Date(job.published_at || job.updated_at).toUTCString()) + '</date>',
    '<referencenumber>' + cdata('lis-' + job.id) + '</referencenumber>',
    '<url>' + cdata(jobUrl(job)) + '</url>',
    '<company>' + cdata(COMPANY_NAME) + '</company>',
    '<sourcename>' + cdata(COMPANY_NAME) + '</sourcename>',
    '<city>' + cdata(job.address_locality) + '</city>',
    '<state>' + cdata(job.address_region) + '</state>',
    '<country>' + cdata('JP') + '</country>',
    '<postalcode>' + cdata(job.postal_code || '') + '</postalcode>',
    '<streetaddress>' + cdata(job.address_street) + '</streetaddress>',
    '<description>' + cdata(textToHtml(fullDescriptionText(job))) + '</description>',
    '<salary>' + cdata(formatPay(job)) + '</salary>',
    '<jobtype>' + cdata(job.employment_type) + '</jobtype>',
    '<category>' + cdata(job.job_category || '') + '</category>',
    '</job>',
  ].join(''));
  return '<?xml version="1.0" encoding="utf-8"?>\n<source>' +
    '<publisher>' + cdata(COMPANY_NAME) + '</publisher>' +
    '<publisherurl>' + cdata(baseUrl() + '/careers') + '</publisherurl>' +
    '<lastBuildDate>' + cdata(new Date().toUTCString()) + '</lastBuildDate>' +
    items.join('') + '</source>\n';
}

const PAGE_STYLE = 'body{font-family:-apple-system,"Hiragino Sans",sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222;line-height:1.7}' +
  'h1{font-size:22px}dl{display:grid;grid-template-columns:7em 1fr;gap:4px 12px}dt{color:#666}' +
  'form{border-top:1px solid #ddd;margin-top:32px;padding-top:16px}input,textarea{width:100%;box-sizing:border-box;padding:8px;margin:4px 0 12px;border:1px solid #ccc;border-radius:6px;font:inherit}' +
  'button{padding:10px 24px;border:none;border-radius:6px;background:#2557a7;color:#fff;font:inherit;cursor:pointer}.hp{display:none}';

function careersIndexHtml(jobs) {
  const items = jobs.map((j) => '<li><a href="/careers/' + encodeURIComponent(j.slug) + '">' + escapeHtml(j.title) + '</a>（' +
    escapeHtml(j.address_locality) + '・' + escapeHtml(formatPay(j)) + '）</li>').join('');
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(COMPANY_NAME) + ' 採用情報</title><style>' + PAGE_STYLE + '</style></head><body>' +
    '<h1>' + escapeHtml(COMPANY_NAME) + ' 採用情報</h1>' + (items ? '<ul>' + items + '</ul>' : '<p>現在募集中の求人はありません。</p>') + '</body></html>';
}

function careersJobHtml(job, validThrough, notice) {
  const conditions = conditionLines(job).map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd>').join('');
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(job.title) + '｜' + escapeHtml(COMPANY_NAME) + '</title><style>' + PAGE_STYLE + '</style>' +
    '<script type="application/ld+json">' + jobPostingJsonLd(job, validThrough) + '</script></head><body>' +
    '<p><a href="/careers">採用情報一覧</a></p><h1>' + escapeHtml(job.wantedly_title || job.title) + '</h1>' +
    '<p>' + textToHtml(job.description) + '</p>' +
    (job.requirements ? '<h2>歓迎する経験</h2><p>' + textToHtml(job.requirements) + '</p>' : '') +
    '<h2>募集条件</h2><dl><dt>職種</dt><dd>' + escapeHtml(job.title) + '</dd>' + conditions + '</dl>' +
    (notice ? '<p><strong>' + escapeHtml(notice) + '</strong></p>' : '') +
    '<form method="post" action="/careers/' + encodeURIComponent(job.slug) + '/apply"><h2>応募する</h2>' +
    '<label>お名前<input name="name" required maxlength="100"></label>' +
    '<label>メールアドレス<input name="email" type="email" required maxlength="200"></label>' +
    '<label>電話番号（任意）<input name="phone" maxlength="30"></label>' +
    '<label>ご経験・メッセージ<textarea name="message" rows="5" maxlength="4000"></textarea></label>' +
    '<label class="hp">会社名<input name="company" tabindex="-1" autocomplete="off"></label>' +
    '<button type="submit">応募する</button></form></body></html>';
}

// Indeed / Wantedly の管理画面に貼り付ける項目一覧（どちらも公開APIがないため最後の公開ボタンは人が押す）
function postingKit(job, platform) {
  if (platform === 'indeed') {
    return {
      dashboard: 'https://employers.indeed.com/',
      fields: [
        ['職種名', job.title],
        ['勤務地', formatAddress(job)],
        ['雇用形態', job.employment_type],
        ['給与', formatPay(job)],
        ['仕事内容', fullDescriptionText(job)],
        ['応募の受け取り先', jobUrl(job)],
      ],
    };
  }
  if (platform === 'wantedly') {
    return {
      dashboard: 'https://admin.wantedly.com/',
      fields: [
        ['募集タイトル', job.wantedly_title],
        ['募集職種', job.job_category || job.title],
        ['こんなことやります（本文）', job.requirements ? job.description + '\n\n【歓迎する経験】\n' + job.requirements : job.description],
        ['募集条件（雇用形態・給与・勤務地）', conditionLines(job).map(([k, v]) => k + '：' + v).join('\n')],
      ],
    };
  }
  throw new Error('posting kit is only for indeed / wantedly');
}

module.exports = {
  COMPANY_NAME,
  jobUrl,
  formatPay,
  fullDescriptionText,
  jobPostingJsonLd,
  indeedXml,
  careersIndexHtml,
  careersJobHtml,
  postingKit,
};
