/**
 * かんたん家計簿：Gmail 連携（Google Apps Script）
 *
 * 「家計簿」ラベルが付いたメールを 15 分ごとに家計簿へ送り、生成 AI で支出を読み取って自動記録します。
 * Gmail を読む権限はあなたの Google アカウントの中だけで使われ、外部に渡されません。
 *
 * 初期設定
 * 1. プロジェクトの設定 → スクリプト プロパティ に次の 3 つを追加
 *      KAKEIBO_URL              https://kakeibo.<あなたのサブドメイン>.workers.dev
 *      CF_ACCESS_CLIENT_ID      Cloudflare Access サービストークンの Client ID
 *      CF_ACCESS_CLIENT_SECRET  Cloudflare Access サービストークンの Client Secret
 * 2. 関数「setup」を選んで実行（権限の確認画面で許可）
 */

const LABEL = '家計簿';
const DONE_LABEL = '家計簿/取込済';
const MAX_PER_RUN = 20;

function setup() {
  getOrCreateLabel_(LABEL);
  getOrCreateLabel_(DONE_LABEL);
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'processMail')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processMail').timeBased().everyMinutes(15).create();
  processMail();
}

function processMail() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('KAKEIBO_URL') || '').replace(/\/+$/, '');
  const id = props.getProperty('CF_ACCESS_CLIENT_ID');
  const secret = props.getProperty('CF_ACCESS_CLIENT_SECRET');
  if (!/^https:\/\//.test(url) || !id || !secret) throw new Error('スクリプト プロパティを設定してください');

  const done = getOrCreateLabel_(DONE_LABEL);
  const threads = GmailApp.search(`label:${LABEL} -label:${DONE_LABEL.replace('/', '-')} newer_than:60d`, 0, MAX_PER_RUN);
  for (const thread of threads) {
    let ok = true;
    for (const msg of thread.getMessages()) {
      const res = UrlFetchApp.fetch(`${url}/api/ingest`, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
        payload: JSON.stringify({
          messageId: msg.getHeader('Message-ID') || msg.getId(),
          from: msg.getFrom(),
          subject: msg.getSubject(),
          date: msg.getDate().toISOString(),
          body: msg.getPlainBody().slice(0, 6000)
        }),
        followRedirects: false,
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code !== 200) {
        ok = false;
        console.warn(`取り込み失敗 (${code}): ${msg.getSubject()} ${res.getContentText().slice(0, 200)}`);
        if (code === 401 || code === 302 || code === 403) throw new Error('認証に失敗しました。サービストークンの設定を確認してください');
        if (code === 409) throw new Error('家計簿アプリでクラウド同期を有効にしてから実行してください');
      }
    }
    if (ok) thread.addLabel(done);
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
