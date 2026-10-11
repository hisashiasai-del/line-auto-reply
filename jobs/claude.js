const Anthropic = require('@anthropic-ai/sdk');
const { formatPay } = require('./feed');

const MODEL = process.env.JOBS_CLAUDE_MODEL || 'claude-opus-5-5';

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const JOB_SYSTEM = [
  'あなたは株式会社LISの採用広報担当として、自社で働くメンバーの求人原稿を書きます。',
  '入力された事実（仕事内容・条件・勤務地）だけを使い、書かれていない条件・数字・待遇は作らないでください。',
  '紹介事業への登録や案件紹介を促す表現（登録、案件紹介、人材バンクなど）は使わず、LISが実際に任せる仕事の募集として書いてください。',
  'Indeed向けの職種名は記号や給与を含めず30文字以内。Wantedly向けのタイトルは報酬を書かず35文字以内で、仕事の魅力が伝わるものにしてください。',
  '本文（description）には報酬額を書かないでください。報酬は別欄に載ります。',
].join('\n');

const JOB_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Indeed用の職種名' },
    wantedly_title: { type: 'string', description: 'Wantedly用のタイトル' },
    description: { type: 'string', description: '仕事内容の本文' },
    requirements: { type: 'string', description: '歓迎する経験' },
    open_questions: { type: 'array', items: { type: 'string' }, description: '公開前に人が確認すべき点' },
  },
  required: ['title', 'wantedly_title', 'description', 'requirements', 'open_questions'],
  additionalProperties: false,
};

async function createJson(system, userText, schema) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to generate this draft');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was truncated');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

function describeJob(job) {
  return [
    '職種名（現行）: ' + (job.title || ''),
    'Wantedlyタイトル（現行）: ' + (job.wantedly_title || ''),
    '契約形態: ' + (job.employment_type || '未入力'),
    '報酬: ' + (formatPay(job) || '未入力'),
    '稼働: ' + (job.work_hours || '未入力'),
    '勤務地: ' + [job.address_region, job.address_locality, job.address_street].filter(Boolean).join(' '),
    '仕事内容（現行）:\n' + (job.description || ''),
    '歓迎する経験（現行）:\n' + (job.requirements || ''),
  ].join('\n');
}

async function generateJobDraft(job, instructions) {
  const text = describeJob(job) + '\n\n' +
    (instructions ? '追加の指示: ' + instructions + '\n\n' : '') +
    '上記をもとに、Indeed・Wantedly・自社求人ページで共通に使える原稿を作成してください。';
  return createJson(JOB_SYSTEM, text, JOB_SCHEMA);
}

const REPLY_SYSTEM = [
  'あなたは株式会社LISの採用担当として、求人への応募者に最初の返信を書きます。',
  '応募のお礼、次のステップとして30分程度のオンライン面談の候補日を伺う旨を、丁寧で簡潔な日本語で書いてください。',
  '採用の確約や、求人に書かれていない条件の約束はしないでください。署名は「株式会社LIS 採用担当」としてください。',
].join('\n');

const REPLY_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

async function generateApplicantReply(job, applicant) {
  const text = '求人: ' + (job ? job.title : '不明') + '\n応募媒体: ' + applicant.platform +
    '\n応募者名: ' + (applicant.name || '不明') + '\n応募メッセージ:\n' + (applicant.message || '（なし）');
  const out = await createJson(REPLY_SYSTEM, text, REPLY_SCHEMA);
  return '件名: ' + out.subject + '\n\n' + out.body;
}

module.exports = { generateJobDraft, generateApplicantReply };
