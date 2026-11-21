# line-auto-reply

公式LINEの返信管理と、面談リマインドの自動送信を行うサーバーです。

## 面談リマインド（自動送信・承認不要）

### 面談の取り込み元
| 取り込み元 | 内容 |
|---|---|
| データベース | `POST /api/meetings` で登録された面談 |
| Google カレンダー | 10分ごとに今後14日分を取得。タイトルに「面談/面接/三者/打ち合わせ…」を含む、または参加者メール・タイトル中の名前が連絡先と一致する予定を取り込む。予定の変更・削除も反映 |
| LINE / Messenger のやり取り | 新着メッセージ（スタッフ送信分を含む）から、合意済みの面談日時・日程変更・キャンセルを Claude で検知 |

同じ時刻の面談は1件にまとめます。例えばフリーランスと LINE で決めた三者面談と、企業と Messenger で決めた三者面談が同じ時刻なら、参加者2名の1件になります。カレンダーの予定とも同じように統合します。

### 送信タイミング（日本時間）
- 前日 12:00
- 当日 9:00
- 9:00 より前に始まる面談には、当日分を送りません。
- 前日12時を過ぎてから登録された面談は、前日分をすぐ送ります。ただし面談まで30分を切っている場合と、3時間以内に当日分が出る場合は送りません。
- 日程が変わったら、旧日時のリマインドを取り消して作り直します。キャンセルされたら取り消します。

### 連絡手段
- フリーランス（`kind=freelancer`）: 公式LINE を優先し、なければ Messenger
- 企業（`kind=company`）: Messenger を優先し、なければ公式LINE
- LINE で連絡してきた相手はフリーランス、Messenger の相手は企業として自動登録します。違う場合は管理画面か API で種別を変えてください。
- 連絡手段がない参加者のリマインドは `no_channel` になり、手段を登録すると自動で有効になります。
- Messenger では、相手の最終メッセージから24時間を過ぎていれば、メッセージタグ `CONFIRMED_EVENT_UPDATE` を付けて送ります。

### 管理画面・API
- 管理画面: `/admin/reminders.html`
- `GET/POST /api/contacts`, `PATCH /api/contacts/:id`
- `GET/POST /api/meetings`, `PATCH /api/meetings/:id`（`status: "cancelled"` でキャンセル）
- `POST /api/meetings/:id/participants` `{contact_id}`, `DELETE /api/meetings/:id/participants/:contactId`
- `GET /api/reminders?status=scheduled|sent|failed|no_channel|cancelled`
- `POST /api/reminders/run`（期限が来た分をすぐ送信）, `POST /api/calendar/sync`, `POST /api/detect` `{channel, id}`

例:
```bash
curl -X POST localhost:3000/api/meetings -H 'Content-Type: application/json' \
  -d '{"title":"三者面談","start_at":"2026-11-25T10:00","participant_ids":[1,2],"location":"https://meet.google.com/xxx"}'
```

### 設定
`.env.example` を参照してください。Messenger の Webhook は `https://<host>/messenger/webhook` に登録し、`messages` と `message_echoes` を購読します。

## テスト
```bash
npm test
```
