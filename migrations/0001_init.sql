-- ユーザーごとの鍵情報と同期カーソル
CREATE TABLE IF NOT EXISTS users (
  user        TEXT PRIMARY KEY,           -- Cloudflare Access で認証されたメールアドレス
  seq         INTEGER NOT NULL DEFAULT 0, -- 最後に採番した変更番号
  key_salt    TEXT,                       -- 合言葉から鍵を導出するためのソルト（公開情報）
  key_iter    INTEGER,                    -- PBKDF2 の反復回数
  key_wrapped TEXT,                       -- 合言葉で暗号化されたデータ鍵（サーバーでは復号不可）
  created_at  INTEGER NOT NULL
);

-- 暗号化済みの記録（明細・固定費）。サーバーは中身を読めない
CREATE TABLE IF NOT EXISTS records (
  user       TEXT NOT NULL,
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  data       TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, id)
);
CREATE INDEX IF NOT EXISTS records_user_seq ON records (user, seq);
