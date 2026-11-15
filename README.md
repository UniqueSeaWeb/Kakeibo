# かんたん家計簿

スマホで使える家計簿 Web アプリ（PWA）です。外食・スーパー・コンビニ・電気・水道・ガス・カーシェア・固定費の支出を記録し、月別・カテゴリ別の金額や 12 か月の推移を確認できます。

Cloudflare（無料枠）で公開すると、**エンドツーエンド暗号化されたクラウド同期**で複数の端末から同じデータを使えます。

## 主な機能

| 画面 | 内容 |
| --- | --- |
| 記録 | カテゴリをタップ → 金額入力 → 記録。メモは過去の入力から候補を表示 |
| 明細 | 月ごとの明細を日付別に表示。カテゴリで絞り込み、タップで編集・削除 |
| 集計 | 月の合計と前月比、分類別の割合、カテゴリ別の金額と前月比、12 か月の推移グラフ |
| 設定 | クラウド同期、メールから自動記録、毎月の固定費（自動記録）、CSV 書き出し、バックアップ・復元 |

## セキュリティ設計

| 層 | 仕組み |
| --- | --- |
| ログイン | **Cloudflare Access**（メールのワンタイムコード）。アプリ全体がログイン必須になり、許可したメールアドレス以外は画面すら表示されません |
| API の認証 | Worker でも Access の JWT（RS256 署名・aud・iss・有効期限）を検証し、許可リスト `ALLOWED_EMAILS` と照合。設定不足や検証失敗はすべて拒否 |
| データの暗号化 | 端末内で **AES-256-GCM** により暗号化してから送信。鍵は合言葉から **PBKDF2-SHA256（60 万回）** で導出。サーバー（Cloudflare）には暗号文しか保存されず、運営者を含め誰も中身を読めません |
| 改ざん検知 | 記録 ID を追加認証データ（AAD）に含め、暗号文の改ざん・入れ替えを検知 |
| 端末内の鍵 | 取り出し不可（non-extractable）の鍵として IndexedDB に保存 |
| Web の防御 | 厳格な CSP（インラインスクリプト禁止）、HSTS、クリックジャッキング対策、同一オリジン + JSON のみ受け付ける CSRF 対策 |

> **合言葉を忘れるとクラウドのデータは復元できません。** 端末内のデータとバックアップファイルは残ります。

## Cloudflare への公開手順（無料）

必要なもの：Cloudflare アカウント、Node.js 20 以上

```sh
npm install
npx wrangler login

# 1. データベースを作成し、表示された database_id を wrangler.jsonc に記入
npx wrangler d1 create kakeibo
npm run db:migrate:remote

# 2. デプロイ（https://kakeibo.<あなたのサブドメイン>.workers.dev で公開）
npm run deploy
```

3. **Cloudflare Access を有効化**
   1. Cloudflare ダッシュボード → Zero Trust を開き、初回はチーム名を決めて Free プランを選択
   2. Workers & Pages → `kakeibo` → **Access** タブで Access を有効化（すべてのトラフィック）
   3. 「Cloudflare Access を管理」から、許可するメールアドレスを自分のものだけにする
   4. Access アプリケーションの **AUD タグ** をコピー
4. `wrangler.jsonc` の `TEAM_DOMAIN`（`https://<チーム名>.cloudflareaccess.com`）と `POLICY_AUD`（AUD タグ）を設定して `npm run deploy`。許可するメールアドレスは `npx wrangler secret put ALLOWED_EMAILS` で登録
5. スマホで URL を開き、メールに届くコードでログイン →「設定 → クラウド同期」で合言葉を設定

2 台目以降の端末は、同じ URL でログインして合言葉を入力するだけで同じデータを使えます。

## Gmail のメールから自動記録（生成 AI）

カードの利用通知・公共料金のお知らせなどのメールを、Cloudflare Workers AI が読み取って自動で明細に追加します。

```
Gmail（「家計簿」ラベル）→ Apps Script（15分ごと）→ Worker /api/ingest → Workers AI で抽出
  → 利用者の公開鍵で暗号化して保存 → アプリを開くと端末で復号して明細に追加
```

- メール本文は Worker と AI の処理中だけメモリ上で扱い、保存しません（Workers AI は入力を保持せず、学習にも使いません）
- 抽出結果は利用者の公開鍵（ECDH P-256）で暗号化して保存され、サーバーは読めません
- 取り込み API は Cloudflare Access の**サービストークン**でのみ呼び出せ、人用の API には使えません
- 同じメールは二重に取り込みません。返金・広告・カードの月次請求合計は除外します

### 設定手順

1. **サービストークンを作成**：Cloudflare ダッシュボード → Zero Trust → アクセス制御 → サービス資格情報 → サービストークン →「作成」（名前：`kakeibo-gmail`）。表示される **Client ID と Client Secret を控える**（Secret は一度しか表示されません）
2. **Access ポリシーに追加**：Zero Trust → アクセス制御 → アプリケーション →「kakeibo - Cloudflare Workers」→ ポリシーを追加：アクション **Service Auth**、含める **Service Token = kakeibo-gmail**
3. **Worker に登録**：`npx wrangler secret put INGEST_CLIENT_ID`（Client ID）と `npx wrangler secret put INGEST_USER`（自分のメールアドレス）
4. **Gmail のフィルタ**：カード会社・電力会社などの差出人を条件に、ラベル「**家計簿**」を付けるフィルタを作成
5. **Apps Script**：https://script.google.com で新しいプロジェクトを作成し、[gmail/Code.gs](gmail/Code.gs) を貼り付け → スクリプト プロパティに `KAKEIBO_URL`・`CF_ACCESS_CLIENT_ID`・`CF_ACCESS_CLIENT_SECRET` を設定 → 関数 `setup` を実行して許可
6. 家計簿アプリでクラウド同期を有効にしておく（取り込み用の鍵が自動で作られます）

### GitHub Pages 版からの移行

1. GitHub Pages 版で「設定 → バックアップを保存」
2. Cloudflare 版で「設定 → バックアップから復元」
3. クラウド同期を設定

## 開発

```sh
npm install
npm run db:migrate:local
echo "DEV_USER=dev@localhost" > .dev.vars   # ローカル専用の認証バイパス（localhost のみ有効）
npm run dev                                   # http://localhost:8787
npm test                                      # JWT 検証のテスト
```

## 構成

```
public/               画面（静的ファイル）
  index.html
  css/style.css       スタイル（余白は 8 の倍数、ダークモード対応）
  js/categories.js    カテゴリ定義
  js/store.js         端末内の保存・固定費の自動記録・同期の変更管理
  js/sync.js          暗号化とクラウド同期
  js/app.js           画面の処理
  sw.js               オフライン対応（Service Worker）
src/ingest.js         メールからの支出抽出（Workers AI）と公開鍵暗号
gmail/Code.gs         Gmail 連携（Google Apps Script）
src/worker.js         API（Access JWT 検証、暗号文の保存・取得）と画面ファイルの配信（CSP などのヘッダー付与）
scripts/build-static.mjs  public/ を Worker に同梱するモジュールを生成（デプロイ時に自動実行）
migrations/           D1 のテーブル定義
wrangler.jsonc        Cloudflare の設定
```

## 無料枠の目安

Workers は 1 日 10 万リクエスト、D1 は 5 GB、Cloudflare Access は 50 ユーザーまで無料です。個人の家計簿であれば十分に収まります。
