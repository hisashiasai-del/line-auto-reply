const test = require('node:test');
const assert = require('node:assert');
const { validateJob } = require('../jobs/policy');

const { complete } = require('./fixtures');

test('complete job passes on every platform', () => {
  for (const p of ['site', 'indeed_feed', 'indeed', 'wantedly']) {
    const v = validateJob(complete, p);
    assert.deepStrictEqual(v.errors, [], p);
  }
});

test('missing confirmations block publishing', () => {
  const v = validateJob(Object.assign({}, complete, { pay_tax: null, work_hours: '', address_street: null }), 'indeed');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors.length, 3);
});

test('placeholder text blocks publishing', () => {
  const v = validateJob(Object.assign({}, complete, { address_street: '確認中' }), 'site');
  assert.ok(v.errors.some((e) => e.includes('確認中')));
});

test('talent-registration wording is rejected', () => {
  for (const phrase of ['まずは無料登録から', '案件をご紹介します', 'エージェント登録はこちら', 'LINEで友だち追加して応募']) {
    const v = validateJob(Object.assign({}, complete, { description: phrase }), 'wantedly');
    assert.strictEqual(v.ok, false, phrase);
  }
});

test('indeed title rules', () => {
  assert.strictEqual(validateJob(Object.assign({}, complete, { title: '【急募】法人営業' }), 'indeed').ok, false);
  assert.strictEqual(validateJob(Object.assign({}, complete, { title: '法人営業 時給3000円' }), 'indeed').ok, false);
  assert.strictEqual(validateJob(Object.assign({}, complete, { title: '【急募】法人営業' }), 'wantedly').ok, true);
});

test('wantedly title may not advertise pay', () => {
  assert.strictEqual(validateJob(Object.assign({}, complete, { wantedly_title: '時給3000円〜の営業' }), 'wantedly').ok, false);
  const v = validateJob(Object.assign({}, complete, { description: '時給3,000円〜です' }), 'wantedly');
  assert.strictEqual(v.ok, true);
  assert.ok(v.warnings.length > 0);
});

