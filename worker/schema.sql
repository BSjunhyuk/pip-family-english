-- Pip과 함께 가족 영어: 가족 계정 서버 데이터베이스 (Cloudflare D1)
-- 이름·이메일·닉네임·사진·음성은 저장하지 않습니다.

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  invite_code TEXT,
  invite_expires INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS families_invite ON families(invite_code);

-- 보호자: 카카오·네이버 회원 식별값을 서버 비밀키로 변환한 값(sub_hash)만 저장
CREATE TABLE IF NOT EXISTS guardians (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  sub_hash TEXT NOT NULL UNIQUE,
  family_id TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guardians_family ON guardians(family_id);

-- 보호자 동의 기록 (만 14세 미만 자녀 기록 처리 근거)
CREATE TABLE IF NOT EXISTS consents (
  guardian_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  version TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS consents_family ON consents(family_id);

-- 학습 기록: 사람은 역할(son/daughter/dad/mom/family)로만 구분
CREATE TABLE IF NOT EXISTS usage (
  family_id TEXT NOT NULL,
  day TEXT NOT NULL,
  profile TEXT NOT NULL,
  sec INTEGER NOT NULL,
  PRIMARY KEY (family_id, day, profile)
);

CREATE TABLE IF NOT EXISTS family_state (
  family_id TEXT PRIMARY KEY,
  levels TEXT NOT NULL DEFAULT '{}',
  records TEXT NOT NULL DEFAULT '{}'
);

-- 같은 동기화 묶음이 두 번 반영되지 않도록 기록
CREATE TABLE IF NOT EXISTS applied_batches (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS batches_family ON applied_batches(family_id);
