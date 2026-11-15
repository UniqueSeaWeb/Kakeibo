// Cloudflare Access の JWT 検証テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt } from '../src/worker.js'; // 事前に npm run build が必要

const TEAM = 'https://example-team.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: 'me@example.com' };

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };

globalThis.fetch = async (url) => {
  assert.equal(String(url), `${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function sign(payload, { key = privateKey, header = { alg: 'RS256', kid: 'k1' } } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: TEAM, aud: [AUD], email: 'me@example.com', iat: now, exp: now + 3600, ...payload };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

test('正しいトークンはメールアドレスを返す', async () => {
  assert.equal(await verifyAccessJwt(await sign({}), env), 'me@example.com');
});
test('トークンなし・形式不正は拒否', async () => {
  assert.equal(await verifyAccessJwt(null, env), null);
  assert.equal(await verifyAccessJwt('a.b', env), null);
  assert.equal(await verifyAccessJwt('a.b.c', env), null);
});
test('別の鍵で署名されたトークンは拒否', async () => {
  assert.equal(await verifyAccessJwt(await sign({}, { key: other.privateKey }), env), null);
});
test('改ざんされたペイロードは拒否', async () => {
  const t = (await sign({})).split('.');
  const p = JSON.parse(Buffer.from(t[1], 'base64url'));
  p.email = 'me@example.com'; p.exp += 99999;
  t[1] = b64url(JSON.stringify(p));
  assert.equal(await verifyAccessJwt(t.join('.'), env), null);
});
test('aud・iss・期限切れ・未知のkid・alg=none は拒否', async () => {
  assert.equal(await verifyAccessJwt(await sign({ aud: ['other'] }), env), null);
  assert.equal(await verifyAccessJwt(await sign({ iss: 'https://evil.cloudflareaccess.com' }), env), null);
  assert.equal(await verifyAccessJwt(await sign({ exp: Math.floor(Date.now() / 1000) - 120 }), env), null);
  assert.equal(await verifyAccessJwt(await sign({}, { header: { alg: 'RS256', kid: 'zzz' } }), env), null);
  assert.equal(await verifyAccessJwt(await sign({}, { header: { alg: 'none', kid: 'k1' } }), env), null);
});
test('許可リストにないメールアドレスは拒否', async () => {
  assert.equal(await verifyAccessJwt(await sign({ email: 'stranger@example.com' }), env), null);
});
test('設定が不足していれば拒否（フェイルクローズ）', async () => {
  const t = await sign({});
  assert.equal(await verifyAccessJwt(t, { ...env, POLICY_AUD: '' }), null);
  assert.equal(await verifyAccessJwt(t, { ...env, TEAM_DOMAIN: '' }), null);
});

import { verifyServiceToken } from '../src/worker.js';
const svcEnv = { ...env, INGEST_CLIENT_ID: 'svc-client.access' };
test('サービストークン：登録した Client ID のみ許可', async () => {
  const svc = await sign({ email: undefined, common_name: 'svc-client.access', sub: '' });
  assert.equal(await verifyServiceToken(svc, svcEnv), true);
  assert.equal(await verifyServiceToken(await sign({ email: undefined, common_name: 'other.access' }), svcEnv), false);
  assert.equal(await verifyServiceToken(svc, env), false);                 // 未設定なら拒否
  assert.equal(await verifyServiceToken(await sign({}), svcEnv), false);   // 人のログインは対象外
  assert.equal(await verifyAccessJwt(svc, svcEnv), null);                  // サービストークンで人の API は使えない
});
