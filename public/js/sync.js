'use strict';

/**
 * クラウド同期（エンドツーエンド暗号化）
 *
 * - 合言葉 → PBKDF2-SHA256（60万回）→ 鍵暗号化鍵（KEK）
 * - 記録の暗号化にはランダムに生成したデータ鍵（DEK, AES-256-GCM）を使い、DEK は KEK で暗号化してサーバーに保管
 * - 各記録は AES-GCM で暗号化し、記録 ID を追加認証データに含めて入れ替え改ざんを検知
 * - この端末の DEK は取り出し不可（non-extractable）の CryptoKey として IndexedDB に保存
 */
const Sync = (() => {
  const PBKDF2_ITERATIONS = 600000;
  const PUSH_BATCH = 100;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let dek = null;
  let running = null;
  let timer = null;
  let status = { state: 'unknown', message: '' };
  const listeners = new Set();

  // ---------- ユーティリティ ----------
  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  function setStatus(state, message = '') {
    status = { state, message };
    listeners.forEach((fn) => fn(status));
  }

  // ---------- IndexedDB（鍵の保管） ----------
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kakeibo-keys', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbOp(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  const loadKey = () => idbOp('readonly', (s) => s.get('dek'));
  const storeKey = (key) => idbOp('readwrite', (s) => s.put(key, 'dek'));
  const deleteKey = () => idbOp('readwrite', (s) => s.delete('dek'));

  // ---------- 暗号 ----------
  async function deriveKek(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }
  const DEK_AAD = enc.encode('kakeibo-dek-v1');

  async function encryptRecord(syncId, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(`kakeibo:v1:${syncId}`) },
      dek, enc.encode(JSON.stringify(obj))
    );
    return toB64(concat(iv, new Uint8Array(ct)));
  }
  async function decryptRecord(syncId, data) {
    const bytes = fromB64(data);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(`kakeibo:v1:${syncId}`) },
      dek, bytes.subarray(12)
    );
    return JSON.parse(dec.decode(pt));
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(code, status) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        redirect: 'manual', // Access のログイン画面へのリダイレクトを検知する
        cache: 'no-store',
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
      });
    } catch {
      throw new ApiError('offline', 0);
    }
    if (res.type === 'opaqueredirect' || res.status === 401) throw new ApiError('login_required', 401);
    const type = res.headers.get('Content-Type') || '';
    if (!type.includes('application/json')) throw new ApiError('unavailable', res.status);
    const body = await res.json();
    if (!res.ok) throw new ApiError(body.error || 'error', res.status);
    return body;
  }

  // ---------- 公開関数 ----------

  /** 同期の利用可否を調べる */
  async function check() {
    try {
      dek = (await loadKey()) || null;
    } catch {
      dek = null;
    }
    try {
      const me = await api('/api/me');
      const { initialized } = await api('/api/key');
      const result = { available: true, email: me.email, initialized, connected: !!dek };
      if (!initialized) setStatus('setup');
      else if (!dek) setStatus('locked');
      else setStatus('idle');
      return result;
    } catch (e) {
      if (e.code === 'login_required') {
        setStatus('login', 'ログインの有効期限が切れました。ページを再読み込みしてください。');
        return { available: true, loginRequired: true, connected: !!dek };
      }
      if (e.code === 'offline' && dek) {
        setStatus('offline', 'オフラインです。接続が戻ると自動で同期します。');
        return { available: true, connected: true, offline: true };
      }
      setStatus('unavailable');
      return { available: false };
    }
  }

  /** 初回設定：合言葉からデータ鍵を作り、暗号化してサーバーに登録 */
  async function setup(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
    const rawDek = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: DEK_AAD }, kek, rawDek);
    await api('/api/key', {
      method: 'PUT',
      body: JSON.stringify({ salt: toB64(salt), iterations: PBKDF2_ITERATIONS, wrappedKey: toB64(concat(iv, new Uint8Array(wrapped))) })
    });
    await activate(rawDek);
  }

  /** 2台目以降：合言葉でデータ鍵を復号してこの端末を接続 */
  async function unlock(passphrase) {
    const info = await api('/api/key');
    if (!info.initialized) throw new ApiError('not_initialized', 0);
    const kek = await deriveKek(passphrase, fromB64(info.salt), info.iterations);
    const wrapped = fromB64(info.wrappedKey);
    let rawDek;
    try {
      rawDek = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.subarray(0, 12), additionalData: DEK_AAD }, kek, wrapped.subarray(12)
      ));
    } catch {
      throw new ApiError('wrong_passphrase', 0);
    }
    await activate(rawDek);
  }

  async function activate(rawDek) {
    const key = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    rawDek.fill(0);
    await storeKey(key);
    dek = key;
    Store.markAllForUpload();
    setStatus('idle');
    await syncNow();
  }

  /** この端末の同期を解除（端末内の記録は残る） */
  async function disconnect() {
    clearTimeout(timer);
    await deleteKey();
    dek = null;
    Store.resetSync();
    setStatus('locked');
  }

  async function runSync() {
    if (!dek) return;
    setStatus('syncing');
    // 1. 送信
    for (;;) {
      const batch = Store.pendingChanges(PUSH_BATCH);
      if (!batch.length) break;
      const changes = await Promise.all(batch.map(async (c) => (
        c.obj ? { id: c.syncId, data: await encryptRecord(c.syncId, c.obj) } : { id: c.syncId, deleted: true }
      )));
      const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ since: Store.lastSeq, changes }) });
      Store.ackChanges(batch);
      await applyRecords(res);
      if (!res.hasMore && batch.length < PUSH_BATCH) break;
    }
    // 2. 受信
    for (;;) {
      const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ since: Store.lastSeq, changes: [] }) });
      await applyRecords(res);
      if (!res.hasMore) break;
    }
    setStatus('idle');
  }

  let changedByRemote = false;
  async function applyRecords(res) {
    for (const r of res.records) {
      try {
        const obj = r.deleted ? null : await decryptRecord(r.id, r.data);
        if (Store.applyRemote(r.id, obj)) changedByRemote = true;
      } catch (e) {
        console.warn('復号できない記録をスキップしました', r.id);
      }
    }
    Store.finishSync(res.cursor);
  }

  async function syncNow() {
    if (!dek) return;
    if (running) return running;
    changedByRemote = false;
    running = runSync()
      .catch((e) => {
        if (e.code === 'login_required') setStatus('login', 'ログインの有効期限が切れました。ページを再読み込みしてください。');
        else if (e.code === 'offline') setStatus('offline', 'オフラインです。接続が戻ると自動で同期します。');
        else setStatus('error', `同期に失敗しました（${e.code || e.message}）`);
      })
      .finally(() => {
        running = null;
        if (changedByRemote) document.dispatchEvent(new CustomEvent('kakeibo:remote-change'));
      });
    return running;
  }

  /** 変更後、少し待ってから同期（連続入力をまとめる） */
  function schedule(delay = 1500) {
    if (!dek) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
  }

  return {
    check, setup, unlock, disconnect, syncNow, schedule,
    get status() { return status; },
    get connected() { return !!dek; },
    onStatus(fn) { listeners.add(fn); },
    PBKDF2_ITERATIONS
  };
})();
