/**
 * かんたん家計簿 クラウド同期 API（Cloudflare Workers + D1）
 *
 * セキュリティ方針
 * - 認証は Cloudflare Access に任せ、Worker 側でも Access の JWT を必ず検証する（多層防御）
 * - データは端末側で AES-256-GCM により暗号化済み。サーバーは暗号文を保存・返却するだけで中身を読めない
 * - 状態を変更するリクエストは同一オリジン + JSON のみ受け付ける（CSRF 対策）
 * - 未設定・検証失敗時はすべて拒否（フェイルクローズ）
 */

import STATIC_FILES from './static.generated.js';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_CHANGES = 100;
const MAX_RECORD_DATA = 16 * 1024;
const PULL_LIMIT = 500;
const ID_RE = /^[er]:[A-Za-z0-9-]{1,80}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}
const fail = (status, error) => json({ error }, status);

// ---------- Cloudflare Access JWT 検証 ----------

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let jwksCache = { at: 0, keys: null, url: '' };

async function getSigningKeys(certsUrl, forceRefresh = false) {
  const fresh = Date.now() - jwksCache.at < 10 * 60 * 1000;
  if (!forceRefresh && fresh && jwksCache.url === certsUrl && jwksCache.keys) return jwksCache.keys;
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error('certs fetch failed');
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys: keys || [], url: certsUrl };
  return jwksCache.keys;
}

/** 検証に成功したらメールアドレスを返す。失敗時は null */
export async function verifyAccessJwt(token, env) {
  if (!token || !env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const teamDomain = env.TEAM_DOMAIN.replace(/\/+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== teamDomain) return null;
  if (!auds.includes(env.POLICY_AUD)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  if (typeof payload.email !== 'string' || !payload.email) return null;

  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  let keys = await getSigningKeys(certsUrl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getSigningKeys(certsUrl, true); // 鍵のローテーションに対応
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA') return null;

  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;

  const email = payload.email.toLowerCase();
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) return null;
  return email;
}

async function authenticate(request, env) {
  // ローカル開発専用（.dev.vars で DEV_USER を設定し、かつ localhost からのアクセスのみ）
  const host = new URL(request.url).hostname;
  if (env.DEV_USER && (host === 'localhost' || host === '127.0.0.1')) return env.DEV_USER;
  try {
    return await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env);
  } catch {
    return null;
  }
}

// ---------- 入力検証 ----------

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && B64_RE.test(s);

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

// ---------- API ----------

async function getKeyInfo(env, user) {
  const row = await env.DB.prepare('SELECT key_salt, key_iter, key_wrapped FROM users WHERE user = ?')
    .bind(user).first();
  if (!row || !row.key_wrapped) return json({ initialized: false });
  return json({ initialized: true, salt: row.key_salt, iterations: row.key_iter, wrappedKey: row.key_wrapped });
}

async function putKeyInfo(request, env, user) {
  const body = await readJson(request);
  const { salt, iterations, wrappedKey } = body || {};
  if (!isB64(salt, 64) || !isB64(wrappedKey, 256) ||
      !Number.isInteger(iterations) || iterations < 300000 || iterations > 5000000) {
    return fail(400, 'invalid_key_info');
  }
  // 鍵情報は最初の 1 回だけ登録できる（上書きによるデータ破壊を防ぐ）
  const res = await env.DB.prepare(
    `INSERT INTO users (user, seq, key_salt, key_iter, key_wrapped, created_at)
     VALUES (?1, 0, ?2, ?3, ?4, ?5)
     ON CONFLICT(user) DO UPDATE SET key_salt = ?2, key_iter = ?3, key_wrapped = ?4
     WHERE users.key_wrapped IS NULL`
  ).bind(user, salt, iterations, wrappedKey, Date.now()).run();
  if (!res.meta.changes) return fail(409, 'already_initialized');
  return json({ ok: true }, 201);
}

async function sync(request, env, user) {
  const body = await readJson(request);
  const since = Number.isInteger(body?.since) && body.since >= 0 ? body.since : 0;
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) return fail(400, 'too_many_changes');

  const keyRow = await env.DB.prepare('SELECT key_wrapped FROM users WHERE user = ?').bind(user).first();
  if (!keyRow || !keyRow.key_wrapped) return fail(409, 'not_initialized');

  const clean = [];
  const seen = new Set();
  for (const c of changes) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id)) return fail(400, 'invalid_change');
    seen.add(c.id);
    if (c.deleted === true) {
      clean.push({ id: c.id, deleted: 1, data: null });
    } else if (isB64(c.data, MAX_RECORD_DATA)) {
      clean.push({ id: c.id, deleted: 0, data: c.data });
    } else {
      return fail(400, 'invalid_change');
    }
  }

  if (clean.length) {
    // seq の採番と書き込みを 1 トランザクション（batch）で行い、取りこぼしを防ぐ
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO records (user, id, seq, deleted, data, updated_at)
         SELECT ?1, json_extract(j.value, '$.id'),
                (SELECT seq FROM users WHERE user = ?1) + j.key + 1,
                json_extract(j.value, '$.deleted'), json_extract(j.value, '$.data'), ?2
         FROM json_each(?3) AS j WHERE true
         ON CONFLICT(user, id) DO UPDATE SET
           seq = excluded.seq, deleted = excluded.deleted, data = excluded.data, updated_at = excluded.updated_at`
      ).bind(user, now, JSON.stringify(clean)),
      env.DB.prepare('UPDATE users SET seq = seq + ?2 WHERE user = ?1').bind(user, clean.length)
    ]);
  }

  const { results } = await env.DB.prepare(
    'SELECT id, seq, deleted, data FROM records WHERE user = ? AND seq > ? ORDER BY seq LIMIT ?'
  ).bind(user, since, PULL_LIMIT + 1).all();
  const hasMore = results.length > PULL_LIMIT;
  const records = results.slice(0, PULL_LIMIT).map((r) => ({
    id: r.id, seq: r.seq, deleted: !!r.deleted, data: r.deleted ? undefined : r.data
  }));
  const cursor = records.length ? records[records.length - 1].seq : since;
  return json({ records, cursor, hasMore });
}

async function handleApi(request, env) {
  const user = await authenticate(request, env);
  if (!user) return fail(401, 'unauthorized');

  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method !== 'GET' && !sameOrigin(request)) return fail(403, 'forbidden_origin');

  if (pathname === '/api/me' && method === 'GET') return json({ email: user });
  if (pathname === '/api/key') {
    if (method === 'GET') return getKeyInfo(env, user);
    if (method === 'PUT') return putKeyInfo(request, env, user);
    return fail(405, 'method_not_allowed');
  }
  if (pathname === '/api/sync') {
    if (method === 'POST') return sync(request, env, user);
    return fail(405, 'method_not_allowed');
  }
  return fail(404, 'not_found');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        console.error(e);
        return fail(500, 'internal_error');
      }
    }
    return serveStatic(request);
  }
};

// ---------- 画面ファイルの配信 ----------

const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'private, no-cache'
};

const decoded = new Map();
function body(file) {
  if (!decoded.has(file.etag)) decoded.set(file.etag, Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0)));
  return decoded.get(file.etag);
}

export function serveStatic(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...PAGE_HEADERS, Allow: 'GET, HEAD' } });
  }
  let { pathname } = new URL(request.url);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname) ? STATIC_FILES[pathname] : null;
  if (!file) return new Response('Not Found', { status: 404, headers: { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
  const headers = { ...PAGE_HEADERS, 'Content-Type': file.type, ETag: file.etag };
  if (request.headers.get('If-None-Match') === file.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body(file), { headers });
}
