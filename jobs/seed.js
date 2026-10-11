// seeds/*.json の求人を取り込む（同じ slug があれば上書き）。使い方: npm run seed:jobs
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { validateJob } = require('./policy');

const dir = path.join(__dirname, '..', 'seeds');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const existing = store.getJob(data.slug);
  const job = existing ? store.updateJob(existing.id, data) : store.createJob(data);
  const v = validateJob(job, 'indeed');
  console.log((existing ? 'updated ' : 'created ') + job.slug + (v.ok ? ' (掲載可能)' : ' (要確認: ' + v.errors.join(' / ') + ')'));
}
