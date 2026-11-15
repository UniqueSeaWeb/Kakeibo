// メール取り込みのテスト（AI 出力の検証・公開鍵暗号の往復）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItems, sealForRecipient, inboxId } from '../src/ingest.js';

test('AI の出力を検証して整形する', () => {
  const items = normalizeItems({
    is_expense: true,
    items: [
      { date: '2026-11-10', amount: 1280, merchant: 'セブン-イレブン', category: 'convenience' },
      { date: 'きのう', amount: '3,300', merchant: 'x'.repeat(50), category: 'unknown' },
      { date: '2026-11-10', amount: 0, merchant: '無効', category: 'dining' },
      { date: '2026-11-10', amount: -5, merchant: '無効', category: 'dining' }
    ]
  }, '2026-11-15');
  assert.deepEqual(items, [
    { date: '2026-11-10', amount: 1280, merchant: 'セブン-イレブン', category: 'convenience' },
    { date: '2026-11-15', amount: 3300, merchant: 'x'.repeat(30), category: 'other' }
  ]);
});

test('支出でないメール・壊れた出力は空', () => {
  assert.deepEqual(normalizeItems({ is_expense: false, items: [{ date: '2026-01-01', amount: 100, merchant: 'a', category: 'other' }] }, '2026-01-01'), []);
  assert.deepEqual(normalizeItems('not json', '2026-01-01'), []);
  assert.deepEqual(normalizeItems('説明文 {"is_expense": true, "items": [{"date":"2026-01-02","amount":500,"merchant":"店","category":"dining"}]}', '2026-01-01'),
    [{ date: '2026-01-02', amount: 500, merchant: '店', category: 'dining' }]);
});

test('Message-ID から決まった ID を作る', async () => {
  const a = await inboxId('<abc@mail>', 0);
  assert.match(a, /^mail-[0-9a-f]{24}-0$/);
  assert.equal(a, await inboxId('<abc@mail>', 0));
  assert.notEqual(a, await inboxId('<abd@mail>', 0));
});

// 端末側（public/js/sync.js の openInboxItem）と同じ手順で復号
async function open(priv, id, data) {
  const enc = new TextEncoder();
  const bytes = Buffer.from(data, 'base64');
  const epk = bytes.subarray(0, 65);
  const pub = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode('kakeibo-inbox-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(65, 77), additionalData: enc.encode(`kakeibo:inbox:${id}`) }, key, bytes.subarray(77));
  return JSON.parse(new TextDecoder().decode(pt));
}

test('公開鍵で暗号化し、秘密鍵でだけ復号できる', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubB64 = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
  const obj = { id: 'mail-x-0', date: '2026-11-15', amount: 980, merchant: 'ラーメン', category: 'dining' };
  const sealed = await sealForRecipient(pubB64, 'mail-x-0', obj);
  assert.ok(!Buffer.from(sealed, 'base64').toString('utf8').includes('ラーメン'));
  assert.deepEqual(await open(pair.privateKey, 'mail-x-0', sealed), obj);
  await assert.rejects(open(other.privateKey, 'mail-x-0', sealed));       // 別の鍵では読めない
  await assert.rejects(open(pair.privateKey, 'mail-y-0', sealed));        // ID の入れ替えを検知
});
