-- メール取り込み用：利用者の公開鍵と、合言葉由来の鍵で暗号化された秘密鍵
ALTER TABLE users ADD COLUMN inbox_pub TEXT;
ALTER TABLE users ADD COLUMN inbox_priv_wrapped TEXT;

-- 取り込み待ちの明細（公開鍵で暗号化済み。端末が受け取ったら削除）
CREATE TABLE IF NOT EXISTS inbox (
  user       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user, id)
);

-- 処理済みメール（Message-ID のハッシュのみ。二重取り込み防止）
CREATE TABLE IF NOT EXISTS ingested (
  user       TEXT NOT NULL,
  msg_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user, msg_hash)
);
