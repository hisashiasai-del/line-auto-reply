// 掲載前チェック。errors が1件でもあれば公開しない。
//
// 根拠:
// - Indeed: 実在する有給の仕事のみ。人材データベース・登録会への誘導は掲載対象外
//   https://jp.indeed.com/help/employers/articles/policy-non-job-posting?co=JP&hl=ja
// - Wantedly: 自社採用のみ。紹介・派遣事業への登録誘導は制限対象。タイトル・本文で報酬を訴求しない
//   https://www.wantedly.com/about/guideline
//   https://service-terms.wantedly.com/posting_policy/ja_JP

// 紹介事業の「登録集め」に見える表現。自社の仕事の募集として書き直す必要がある
const REGISTRATION_PATTERNS = [
  /無料登録/,
  /(人材|エージェント|派遣|会員|案件)登録/,
  /登録(者|制|のみ|会|して|いただ|はこちら)/,
  /(案件|お仕事|仕事)(を|の)?(ご)?紹介/,
  /人材バンク/,
  /(友だち|友達)(追加|登録)/,
];

// 確定していない値がそのまま残っている
const PLACEHOLDER_PATTERNS = [/確認中/, /確認待ち/, /未定/, /未確定/, /TBD/i, /XXX/i, /〇〇/, /○○/];

const INDEED_TITLE_SYMBOLS = /[【】「」『』★☆◆◇■□●◎♪！!？?＼／|※]/;
const PAY_WORDS = /(時給|日給|月給|年収|年俸|報酬|[0-9０-９,，]+\s*円|万円)/;

const REQUIRED = [
  ['title', 'Indeed用の職種名（title）'],
  ['description', '仕事内容（description）'],
  ['employment_type', '雇用・契約形態（employment_type）'],
  ['pay_min', '報酬の下限（pay_min）'],
  ['pay_unit', '報酬の単位（pay_unit: 時給/月給/年収）'],
  ['pay_tax', '報酬の税込・税別（pay_tax）'],
  ['work_hours', '稼働日数・時間帯（work_hours）'],
  ['address_region', '勤務地の都道府県（address_region）'],
  ['address_locality', '勤務地の市区町村（address_locality）'],
  ['address_street', '勤務地の番地・建物（address_street）'],
];

const TEXT_FIELDS = ['title', 'job_category', 'wantedly_title', 'description', 'requirements',
  'employment_type', 'pay_tax', 'transport_fee', 'work_hours', 'address_region', 'address_locality', 'address_street'];

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function validateJob(job, platform) {
  const errors = [];
  const warnings = [];

  for (const [field, label] of REQUIRED) {
    if (isBlank(job[field])) errors.push(label + ' が未入力です');
  }
  if (!isBlank(job.pay_unit) && !['時給', '月給', '年収'].includes(job.pay_unit)) {
    errors.push('pay_unit は 時給 / 月給 / 年収 のいずれかにしてください');
  }
  if (!isBlank(job.pay_tax) && !['税込', '税別'].includes(job.pay_tax)) {
    errors.push('pay_tax は 税込 / 税別 のいずれかにしてください');
  }
  if (!isBlank(job.pay_max) && !isBlank(job.pay_min) && Number(job.pay_max) < Number(job.pay_min)) {
    errors.push('pay_max が pay_min より小さくなっています');
  }
  if (isBlank(job.transport_fee)) warnings.push('交通費の扱い（transport_fee）が未記入です');

  for (const field of TEXT_FIELDS) {
    const value = job[field];
    if (isBlank(value)) continue;
    for (const re of PLACEHOLDER_PATTERNS) {
      if (re.test(value)) {
        errors.push(field + ' に未確定の表記（' + value.match(re)[0] + '）が残っています');
        break;
      }
    }
  }

  const body = [job.title, job.wantedly_title, job.description, job.requirements].filter(Boolean).join('\n');
  for (const re of REGISTRATION_PATTERNS) {
    const m = body.match(re);
    if (m) {
      errors.push('「' + m[0] + '」は登録・紹介への誘導と判断されます。自社で任せる仕事の募集として書き直してください');
    }
  }

  if (platform === 'indeed' || platform === 'indeed_feed') {
    if (!isBlank(job.title)) {
      if (INDEED_TITLE_SYMBOLS.test(job.title)) errors.push('Indeedの職種名に記号（【】★！など）は使えません');
      if (PAY_WORDS.test(job.title)) errors.push('Indeedの職種名に給与を入れないでください');
      if (job.title.length > 30) warnings.push('Indeedの職種名は30文字以内が目安です（現在' + job.title.length + '文字）');
    }
  }

  if (platform === 'wantedly') {
    if (isBlank(job.wantedly_title)) {
      errors.push('Wantedly用のタイトル（wantedly_title）が未入力です');
    } else {
      if (PAY_WORDS.test(job.wantedly_title)) errors.push('Wantedlyのタイトルで報酬を訴求できません');
      if (job.wantedly_title.length > 35) warnings.push('Wantedlyのタイトルは35文字以内が目安です（現在' + job.wantedly_title.length + '文字）');
    }
    if (!isBlank(job.description) && PAY_WORDS.test(job.description)) {
      warnings.push('Wantedlyでは本文で報酬を強調せず、募集条件欄に記載してください');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateJob };
