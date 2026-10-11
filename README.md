# line-auto-reply

LINE公式アカウントの返信下書き（`/admin/admin.html`）と、求人の掲載・運用自動化（`/admin/jobs.html`）をまとめたサーバーです。

```bash
npm install
npm run seed:jobs   # seeds/*.json の求人を取り込む
npm start
npm test
```

## 求人の掲載・運用

### 掲載の流れ

| 掲載先 | 自動化の範囲 | 操作 |
|---|---|---|
| 自社求人ページ `/careers/:slug` | 全自動。Google しごと検索用の JSON-LD（JobPosting）を埋め込み、応募フォームの応募は自動で登録される | 「自社ページに掲載」 |
| Indeed XMLフィード `/feeds/indeed.xml` | 全自動。掲載中の求人を Indeed の XML 形式で出力する | 「Indeedフィードに掲載」→ フィードURLを Indeed に登録（下記） |
| Indeed 管理画面 | 半自動。項目ごとの貼り付け用テキスト（掲載キット）を作る。公開ボタンは人が押す | 「Indeedに掲載」→ 貼り付け → 公開URLを登録 |
| Wantedly 管理画面 | 半自動。同上。掲載期限（既定30日）を管理する | 「Wantedlyに掲載」→ 貼り付け → 公開URLを登録 |

Indeed と Wantedly には一般企業向けの掲載APIがないため、管理画面での公開は人が行います。Indeed の XML フィードを取り込んでもらうには、Indeed の担当窓口へフィードURLの登録申請が必要です（審査あり）。

### 掲載前チェック（`jobs/policy.js`）

次のどれかに当たると公開できません。

- 報酬（下限・単位・税込/税別）、稼働条件、勤務地の番地までの住所が未入力
- 「確認中」「未定」などの仮置きの文言が残っている
- 「無料登録」「案件紹介」「友だち追加」など、紹介事業への登録を誘う表現がある（Indeed・Wantedly とも、自社で任せる仕事の募集しか掲載できないため）
- Indeed の職種名に記号や給与が入っている、または Wantedly のタイトルで報酬を打ち出している

### 自動運用（毎日9:00 JST、`jobs/ops.js`）

- 掲載期限の3日前に通知し、期限を過ぎた掲載は「期限切れ」にする
- 24時間以上未対応の応募者を通知し、返信の下書きを Claude で作る
- 14日間応募がない掲載中の求人を「見直し候補」として通知する
- 結果を Slack に送る（`SLACK_WEBHOOK_URL` 未設定時はログ出力）

### Indeed・Wantedly の応募を取り込む

両媒体の応募通知メールを Make や Gmail 連携で解析し、次の形で送ると応募者一覧に入ります（同じ `external_id` は重複登録されません）。

```
POST /api/intake/applicants
x-intake-token: <INTAKE_TOKEN>
{ "platform": "indeed", "external_id": "応募ID", "job": "sales-member", "name": "...", "email": "...", "phone": "...", "message": "..." }
```

### 環境変数

| 名前 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | 原稿の整形・応募者への返信下書き |
| `PUBLIC_BASE_URL` | 求人ページとフィードに載せる公開URL（例 `https://recruit.example.com`） |
| `COMPANY_NAME` / `COMPANY_URL` | 求人に表示する会社名・会社サイト |
| `INTAKE_TOKEN` | 応募取り込みAPIの認証トークン |
| `SLACK_WEBHOOK_URL` | 運用通知の送信先 |
| `WANTEDLY_DEFAULT_DAYS` | Wantedly の掲載期間（既定30日） |
| `APPLICANT_SLA_HOURS` / `JOB_EXPIRY_WARN_DAYS` / `JOB_STALE_DAYS` | 通知のしきい値（既定 24時間 / 3日 / 14日） |
| `JOB_OPS_CRON` | 日次運用の実行時刻（既定 `0 9 * * *`、Asia/Tokyo） |
| `DB_PATH` | SQLite のファイル（既定 `data.sqlite`） |

`/admin` と `/api` には認証がありません。公開サーバーに置くときは、リバースプロキシなどで社内だけに制限してください。
