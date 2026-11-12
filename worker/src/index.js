/* =====================================================================
   Pip과 함께 가족 영어 — 가족 계정 서버 (Cloudflare Worker + D1)

   하는 일
   - 카카오·네이버 로그인 (보호자만). 회원 식별값은 서버 비밀키로 변환해서만 저장
   - 가족 만들기, 6자리 초대 코드로 보호자 묶기 (최대 4명)
   - 기기 간 학습 기록 동기화 (사용 시간은 더하기, 별점·연습 횟수는 큰 값, 난이도는 나중에 바꾼 값)
   - 보호자 동의 기록, 연결 끊기, 가족 전체 삭제
   - 3개월 동안 아무도 쓰지 않은 가족은 자동 삭제 (매일 새벽 실행)

   저장하지 않는 것: 이름, 이메일, 닉네임, 프로필 사진, 전화번호, 음성, 말한 문장, IP
   ===================================================================== */

const DAY_MS = 86400000;
const INACTIVE_DAYS = 90;            // 3개월 미사용 시 삭제
const SESSION_DAYS = 30;
const INVITE_HOURS = 24;
const MAX_GUARDIANS = 4;
const CONSENT_VERSIONS = ["v2"];
const PROFILES = ["son", "daughter", "dad", "mom", "family"];
const LEVEL_KEYS = ["family", "daughter", "dad", "mom"];
const RECORD_KEY = /^(shadowStars_[1-5]|reps_(dad|mom)_L[1-5]_\d{4}-\d{2}-\d{2})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const PROVIDERS = {
  kakao: {
    authorize: (env, redirect, state) =>
      "https://kauth.kakao.com/oauth/authorize?" + new URLSearchParams({
        response_type: "code", client_id: env.KAKAO_REST_KEY, redirect_uri: redirect, state
      }),
    async subject(env, code, redirect) {
      const tok = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY,
          client_secret: env.KAKAO_CLIENT_SECRET || "", redirect_uri: redirect, code
        })
      }).then(r => r.json());
      if (!tok.access_token) throw new Error("kakao_token");
      const me = await fetch("https://kapi.kakao.com/v2/user/me", {
        headers: { Authorization: "Bearer " + tok.access_token }
      }).then(r => r.json());
      if (!me.id) throw new Error("kakao_profile");
      return String(me.id); // 회원번호만 사용. 닉네임 등은 읽지 않음
    }
  },
  naver: {
    authorize: (env, redirect, state) =>
      "https://nid.naver.com/oauth2.0/authorize?" + new URLSearchParams({
        response_type: "code", client_id: env.NAVER_CLIENT_ID, redirect_uri: redirect, state
      }),
    async subject(env, code, redirect, state) {
      const tok = await fetch("https://nid.naver.com/oauth2.0/token?" + new URLSearchParams({
        grant_type: "authorization_code", client_id: env.NAVER_CLIENT_ID,
        client_secret: env.NAVER_CLIENT_SECRET, code, state
      })).then(r => r.json());
      if (!tok.access_token) throw new Error("naver_token");
      const me = await fetch("https://openapi.naver.com/v1/nid/me", {
        headers: { Authorization: "Bearer " + tok.access_token }
      }).then(r => r.json());
      if (!me.response || !me.response.id) throw new Error("naver_profile");
      return String(me.response.id); // 회원 식별값만 사용
    }
  }
};

/* ---------------- 공통 도구 ---------------- */
const enc = new TextEncoder();
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64u(new Uint8Array(sig));
}
function b64u(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uJson(obj) { return b64u(enc.encode(JSON.stringify(obj))); }
function fromB64uJson(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function rid(n = 16) { return b64u(crypto.getRandomValues(new Uint8Array(n))); }
function inviteCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0,O,1,I 제외
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, b => A[b % A.length]).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function issueToken(env, guardianId) {
  const body = b64uJson({ g: guardianId, exp: Date.now() + SESSION_DAYS * DAY_MS });
  return body + "." + await hmac(env.SESSION_SECRET, "session." + body);
}
async function readToken(env, req) {
  const h = req.headers.get("Authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, "session." + body))) return null;
  try { const p = fromB64uJson(body); return p.exp > Date.now() ? p.g : null; } catch { return null; }
}
function appOrigin(env) { return new URL(env.APP_URL).origin; }
function cors(env) {
  return {
    "Access-Control-Allow-Origin": appOrigin(env),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(env) }
  });
}
function backToApp(env, fragment) {
  return new Response(null, { status: 302, headers: { Location: env.APP_URL + "#" + fragment, "Cache-Control": "no-store" } });
}
function cookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

/* ---------------- 데이터베이스 ---------------- */
async function touch(env, guardian) {
  const now = Date.now();
  const stmts = [env.DB.prepare("UPDATE guardians SET last_active=? WHERE id=?").bind(now, guardian.id)];
  if (guardian.family_id) stmts.push(env.DB.prepare("UPDATE families SET last_active=? WHERE id=?").bind(now, guardian.family_id));
  await env.DB.batch(stmts);
}
async function getGuardian(env, id) {
  return env.DB.prepare("SELECT * FROM guardians WHERE id=?").bind(id).first();
}
async function familyInfo(env, familyId) {
  if (!familyId) return null;
  const f = await env.DB.prepare("SELECT * FROM families WHERE id=?").bind(familyId).first();
  if (!f) return null;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM guardians WHERE family_id=?").bind(familyId).first();
  const invite = f.invite_code && f.invite_expires > Date.now() ? { code: f.invite_code, expires: f.invite_expires } : null;
  return { id: f.id, guardians: n, invite };
}
async function deleteFamily(env, familyId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage WHERE family_id=?").bind(familyId),
    env.DB.prepare("DELETE FROM family_state WHERE family_id=?").bind(familyId),
    env.DB.prepare("DELETE FROM consents WHERE family_id=?").bind(familyId),
    env.DB.prepare("DELETE FROM applied_batches WHERE family_id=?").bind(familyId),
    env.DB.prepare("DELETE FROM guardians WHERE family_id=?").bind(familyId),
    env.DB.prepare("DELETE FROM families WHERE id=?").bind(familyId)
  ]);
}
async function familyState(env, familyId) {
  const since = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
  const rows = (await env.DB.prepare("SELECT day, profile, sec FROM usage WHERE family_id=? AND day>=?").bind(familyId, since).all()).results;
  const usage = {};
  for (const r of rows) { (usage[r.day] = usage[r.day] || {})[r.profile] = r.sec; }
  const st = await env.DB.prepare("SELECT levels, records FROM family_state WHERE family_id=?").bind(familyId).first();
  return { usage, levels: st ? JSON.parse(st.levels) : {}, records: st ? JSON.parse(st.records) : {} };
}

/* ---------------- 동기화 병합 ---------------- */
function clampInt(v, lo, hi) { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; }
async function applySync(env, familyId, body) {
  const batchId = typeof body.batchId === "string" && body.batchId.length <= 64 ? body.batchId : null;
  if (batchId) {
    const seen = await env.DB.prepare("SELECT id FROM applied_batches WHERE id=?").bind(familyId + ":" + batchId).first();
    if (seen) return; // 이미 반영된 묶음: 사용 시간이 두 번 더해지지 않도록
  }
  const stmts = [];
  // 사용 시간: 더하기
  const usage = body.usage && typeof body.usage === "object" ? body.usage : {};
  for (const day of Object.keys(usage).slice(0, 120)) {
    if (!DAY_RE.test(day)) continue;
    for (const p of Object.keys(usage[day] || {})) {
      if (!PROFILES.includes(p)) continue;
      const sec = clampInt(usage[day][p], 0, 6 * 3600);
      if (!sec) continue;
      stmts.push(env.DB.prepare(
        "INSERT INTO usage (family_id, day, profile, sec) VALUES (?,?,?,?) ON CONFLICT(family_id, day, profile) DO UPDATE SET sec = MIN(sec + excluded.sec, 86400)"
      ).bind(familyId, day, p, sec));
    }
  }
  // 난이도: 나중에 바꾼 값 / 기록: 큰 값
  const cur = await env.DB.prepare("SELECT levels, records FROM family_state WHERE family_id=?").bind(familyId).first();
  const levels = cur ? JSON.parse(cur.levels) : {};
  const records = cur ? JSON.parse(cur.records) : {};
  for (const k of LEVEL_KEYS) {
    const inc = body.levels && body.levels[k];
    if (!inc) continue;
    const v = Number(inc.v), at = clampInt(inc.at, 0, Date.now() + DAY_MS);
    if (!Number.isInteger(v) || v < 1 || v > 5) continue; // 잘못된 단계는 버림
    if (at !== null && (!levels[k] || at > levels[k].at)) levels[k] = { v, at };
  }
  const recIn = body.records && typeof body.records === "object" ? body.records : {};
  for (const key of Object.keys(recIn).slice(0, 400)) {
    if (!RECORD_KEY.test(key) || typeof recIn[key] !== "object") continue;
    const dst = records[key] = records[key] || {};
    for (const idx of Object.keys(recIn[key]).slice(0, 20)) {
      const i = clampInt(idx, 0, 19), n = clampInt(recIn[key][idx], 0, 3);
      if (i === null || n === null) continue;
      dst[i] = Math.max(dst[i] || 0, n);
    }
  }
  // 오래된 연습 횟수 기록(60일 지난 것)은 정리
  const cutoff = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
  for (const key of Object.keys(records)) { const m = key.match(/_(\d{4}-\d{2}-\d{2})$/); if (m && m[1] < cutoff) delete records[key]; }
  stmts.push(env.DB.prepare(
    "INSERT INTO family_state (family_id, levels, records) VALUES (?,?,?) ON CONFLICT(family_id) DO UPDATE SET levels=excluded.levels, records=excluded.records"
  ).bind(familyId, JSON.stringify(levels), JSON.stringify(records)));
  if (batchId) stmts.push(env.DB.prepare("INSERT INTO applied_batches (id, family_id, at) VALUES (?,?,?)").bind(familyId + ":" + batchId, familyId, Date.now()));
  await env.DB.batch(stmts);
}

/* ---------------- 요청 처리 ---------------- */
async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

  // 로그인 시작: /auth/kakao/start, /auth/naver/start
  let m = path.match(/^\/auth\/(kakao|naver)\/start$/);
  if (m && req.method === "GET") {
    const provider = m[1];
    const nonce = rid(18);
    const redirect = url.origin + "/auth/" + provider + "/callback";
    return new Response(null, {
      status: 302,
      headers: {
        Location: PROVIDERS[provider].authorize(env, redirect, nonce),
        "Set-Cookie": `pip_state=${nonce}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        "Cache-Control": "no-store"
      }
    });
  }

  // 로그인 결과: /auth/kakao/callback, /auth/naver/callback
  m = path.match(/^\/auth\/(kakao|naver)\/callback$/);
  if (m && req.method === "GET") {
    const provider = m[1];
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (url.searchParams.get("error")) return backToApp(env, "auth_error=cancelled");
    const saved = cookie(req, "pip_state");
    if (!code || !state || !saved || !safeEqual(state, saved)) return backToApp(env, "auth_error=state");
    let sub;
    try { sub = await PROVIDERS[provider].subject(env, code, url.origin + "/auth/" + provider + "/callback", state); }
    catch (e) { return backToApp(env, "auth_error=provider"); }
    const subHash = await hmac(env.SESSION_SECRET, "sub." + provider + "." + sub);
    let g = await env.DB.prepare("SELECT * FROM guardians WHERE sub_hash=?").bind(subHash).first();
    const now = Date.now();
    if (!g) {
      g = { id: rid(12), family_id: null };
      await env.DB.prepare("INSERT INTO guardians (id, provider, sub_hash, family_id, created_at, last_active) VALUES (?,?,?,?,?,?)")
        .bind(g.id, provider, subHash, null, now, now).run();
    } else {
      await touch(env, g);
    }
    const resp = backToApp(env, "auth=" + await issueToken(env, g.id));
    resp.headers.append("Set-Cookie", "pip_state=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return resp;
  }

  // 로컬 테스트 전용 로그인 (배포 환경에서는 DEV_LOGIN이 없어 꺼져 있음)
  if (path === "/auth/dev" && env.DEV_LOGIN === "1") {
    const who = url.searchParams.get("who") || "dev";
    const subHash = await hmac(env.SESSION_SECRET, "sub.dev." + who);
    let g = await env.DB.prepare("SELECT * FROM guardians WHERE sub_hash=?").bind(subHash).first();
    if (!g) { g = { id: rid(12) }; const now = Date.now();
      await env.DB.prepare("INSERT INTO guardians (id, provider, sub_hash, family_id, created_at, last_active) VALUES (?,?,?,?,?,?)").bind(g.id, "dev", subHash, null, now, now).run(); }
    return json(env, { token: await issueToken(env, g.id) });
  }

  if (path === "/" || path === "/health") return json(env, { ok: true, service: "pip-family-api" });

  // 여기부터는 로그인한 보호자만
  const gid = await readToken(env, req);
  if (!gid) return json(env, { error: "unauthorized" }, 401);
  const g = await getGuardian(env, gid);
  if (!g) return json(env, { error: "unauthorized" }, 401);
  await touch(env, g);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (path === "/me" && req.method === "GET") {
    return json(env, { guardian: { id: g.id, provider: g.provider }, family: await familyInfo(env, g.family_id) });
  }

  if (path === "/family" && req.method === "POST") {
    if (g.family_id) return json(env, { error: "already_in_family" }, 409);
    if (!CONSENT_VERSIONS.includes(body.consentVersion)) return json(env, { error: "consent_required" }, 400);
    const fid = rid(12), now = Date.now(), code = inviteCode();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO families (id, created_at, last_active, invite_code, invite_expires) VALUES (?,?,?,?,?)").bind(fid, now, now, code, now + INVITE_HOURS * 3600000),
      env.DB.prepare("UPDATE guardians SET family_id=? WHERE id=?").bind(fid, g.id),
      env.DB.prepare("INSERT INTO consents (guardian_id, family_id, version, at) VALUES (?,?,?,?)").bind(g.id, fid, body.consentVersion, now),
      env.DB.prepare("INSERT INTO family_state (family_id) VALUES (?)").bind(fid)
    ]);
    return json(env, { family: await familyInfo(env, fid) });
  }

  if (path === "/family/invite" && req.method === "POST") {
    if (!g.family_id) return json(env, { error: "no_family" }, 400);
    const code = inviteCode(), exp = Date.now() + INVITE_HOURS * 3600000;
    await env.DB.prepare("UPDATE families SET invite_code=?, invite_expires=? WHERE id=?").bind(code, exp, g.family_id).run();
    return json(env, { family: await familyInfo(env, g.family_id) });
  }

  if (path === "/family/join" && req.method === "POST") {
    if (g.family_id) return json(env, { error: "already_in_family" }, 409);
    if (!CONSENT_VERSIONS.includes(body.consentVersion)) return json(env, { error: "consent_required" }, 400);
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) return json(env, { error: "bad_code" }, 400);
    const f = await env.DB.prepare("SELECT * FROM families WHERE invite_code=? AND invite_expires>?").bind(code, Date.now()).first();
    if (!f) return json(env, { error: "bad_code" }, 400);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM guardians WHERE family_id=?").bind(f.id).first();
    if (n >= MAX_GUARDIANS) return json(env, { error: "family_full" }, 409);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE guardians SET family_id=? WHERE id=?").bind(f.id, g.id),
      env.DB.prepare("INSERT INTO consents (guardian_id, family_id, version, at) VALUES (?,?,?,?)").bind(g.id, f.id, body.consentVersion, now),
      env.DB.prepare("UPDATE families SET last_active=? WHERE id=?").bind(now, f.id)
    ]);
    return json(env, { family: await familyInfo(env, f.id) });
  }

  if (path === "/sync" && req.method === "POST") {
    if (!g.family_id) return json(env, { error: "no_family" }, 400);
    await applySync(env, g.family_id, body);
    return json(env, { state: await familyState(env, g.family_id), at: Date.now() });
  }

  // 동의 철회: 이 보호자 연결만 끊기. 마지막 보호자면 가족 전체 삭제
  if (path === "/leave" && req.method === "POST") {
    const fid = g.family_id;
    await env.DB.prepare("DELETE FROM guardians WHERE id=?").bind(g.id).run();
    if (fid) {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM guardians WHERE family_id=?").bind(fid).first();
      if (n === 0) await deleteFamily(env, fid);
      else await env.DB.prepare("DELETE FROM consents WHERE guardian_id=?").bind(g.id).run();
    }
    return json(env, { ok: true });
  }

  // 가족 계정과 기록 모두 삭제
  if (path === "/family" && req.method === "DELETE") {
    if (g.family_id) await deleteFamily(env, g.family_id);
    else await env.DB.prepare("DELETE FROM guardians WHERE id=?").bind(g.id).run();
    return json(env, { ok: true });
  }

  return json(env, { error: "not_found" }, 404);
}

/* ---------------- 3개월 미사용 자동 삭제 ---------------- */
async function cleanup(env) {
  const cutoff = Date.now() - INACTIVE_DAYS * DAY_MS;
  const old = (await env.DB.prepare("SELECT id FROM families WHERE last_active < ?").bind(cutoff).all()).results;
  for (const f of old) await deleteFamily(env, f.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM guardians WHERE family_id IS NULL AND last_active < ?").bind(cutoff),
    env.DB.prepare("UPDATE families SET invite_code=NULL, invite_expires=NULL WHERE invite_expires < ?").bind(Date.now()),
    env.DB.prepare("DELETE FROM applied_batches WHERE at < ?").bind(Date.now() - 30 * DAY_MS)
  ]);
  return old.length;
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(env, { error: "server_error" }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(cleanup(env)); }
};
export { cleanup };
