# かんたん家計簿

スマホで使える家計簿 Web アプリ（PWA）です。外食・スーパー・コンビニ・電気・水道・ガス・カーシェア・固定費の支出を記録し、月別・カテゴリ別の金額や 12 か月の推移を確認できます。

Cloudflare（無料枠）で公開すると、**エンドツーエンド暗号化されたクラウド同期**で複数の端末から同じデータを使えます。

## 主な機能

| 画面 | 内容 |
| --- | --- |
| 記録 | カテゴリをタップ → 金額入力 → 記録。メモは過去の入力から候補を表示 |
| 明細 | 月ごとの明細を日付別に表示。カテゴリで絞り込み、タップで編集・削除 |
| 集計 | 月の合計と前月比、分類別の割合、カテゴリ別の金額と前月比、12 か月の推移グラフ |
| 設定 | クラウド同期、毎月の固定費（自動記録）、CSV 書き出し、バックアップ・復元 |

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
   2. Workers & Pages → `kakeibo` → 設定 → ドメインとルート → `workers.dev` の **Cloudflare Access を有効にする**
   3. 「Cloudflare Access を管理」から、許可するメールアドレスを自分のものだけにする
   4. Access アプリケーションの **AUD タグ** をコピー
4. `wrangler.jsonc` の `TEAM_DOMAIN`（`https://<チーム名>.cloudflareaccess.com`）、`POLICY_AUD`（AUD タグ）、`ALLOWED_EMAILS`（自分のメールアドレス）を設定して、もう一度 `npm run deploy`
5. スマホで URL を開き、メールに届くコードでログイン →「設定 → クラウド同期」で合言葉を設定

2 台目以降の端末は、同じ URL でログインして合言葉を入力するだけで同じデータを使えます。

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
  _headers            セキュリティヘッダー（CSP など）
  css/style.css       スタイル（余白は 8 の倍数、ダークモード対応）
  js/categories.js    カテゴリ定義
  js/store.js         端末内の保存・固定費の自動記録・同期の変更管理
  js/sync.js          暗号化とクラウド同期
  js/app.js           画面の処理
  sw.js               オフライン対応（Service Worker）
src/worker.js         API（Access JWT 検証、暗号文の保存・取得）
migrations/           D1 のテーブル定義
wrangler.jsonc        Cloudflare の設定
```

## 無料枠の目安

Workers は 1 日 10 万リクエスト、D1 は 5 GB、Cloudflare Access は 50 ユーザーまで無料です。個人の家計簿であれば十分に収まります。
