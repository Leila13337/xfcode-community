import http from 'node:http';
import { installProfiles } from './profiles.mjs';
import { bootstrapAdmin } from './admin-bootstrap.mjs';
import { installFeatures } from './features.mjs';
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.GS_DATA_DIR || path.join(ROOT, 'data');
await mkdir(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'forum.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT \'Asia/Shanghai\', privacy TEXT NOT NULL DEFAULT \'private\', email_verified INTEGER NOT NULL DEFAULT 1 CHECK(email_verified IN (0,1)), created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS forums (id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL, sort INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, forum_id INTEGER NOT NULL REFERENCES forums(id), author_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS saved (user_id INTEGER REFERENCES users(id), topic_id INTEGER REFERENCES topics(id), PRIMARY KEY(user_id, topic_id)); CREATE TABLE IF NOT EXISTS email_codes (id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))); CREATE INDEX IF NOT EXISTS email_codes_lookup ON email_codes(email, created);');
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))');
if (!userColumns.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1 CHECK(email_verified IN (0,1))');
const derive = promisify(scrypt);
const hashToken = value => createHash('sha256').update(value).digest('hex');
const errors = (status, message) => Object.assign(new Error(message), { status });
const now = () => Date.now();
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY?.trim() || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY?.trim() || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || '';
const MAIL_FROM = process.env.MAIL_FROM?.trim() || '';
const EMAIL_CODE_SECRET = process.env.EMAIL_CODE_SECRET?.trim() || randomBytes(32).toString('hex');
const TURNSTILE_ENABLED = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);
const EMAIL_VERIFICATION_ENABLED = Boolean(RESEND_API_KEY && MAIL_FROM);
const EMAIL_CODE_TTL = 10 * 60 * 1000;
const EMAIL_CODE_COOLDOWN = 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const authConfig = () => ({turnstileEnabled:TURNSTILE_ENABLED,turnstileSiteKey:TURNSTILE_ENABLED?TURNSTILE_SITE_KEY:'',emailVerificationEnabled:EMAIL_VERIFICATION_ENABLED});
const publicUser = id => { const user = db.prepare("SELECT u.id,u.username,u.created,u.timezone,u.privacy,(SELECT '/avatars/'||u.id||'?v='||avatar_version FROM user_profiles WHERE user_id=u.id) AS avatarUrl,coalesce(r.role,'member') AS role,m.expires AS subscriptionExpires FROM users u LEFT JOIN user_roles r ON r.user_id=u.id LEFT JOIN memberships m ON m.user_id=u.id WHERE u.id=?").get(id); return user ? {...user,isSubscriber:Boolean(user.subscriptionExpires && user.subscriptionExpires>now())} : null; };

if (!db.prepare('SELECT id FROM forums LIMIT 1').get()) {
  db.exec('BEGIN');
  try {
    const addForum = db.prepare('INSERT INTO forums (category,name,description,icon,sort) VALUES (?,?,?,?,?)');
    [
      ['General', 'Announcements', 'Stay up to date with the latest news.', 'announcement', 1],
      ['General', 'General talk', 'Talk about anything with the community.', 'chat', 2],
      ['General', 'Spotlight', 'Show off screenshots, videos and your latest creations.', 'image', 3],
      ['Premium lounge', 'CS:GO Discussion', 'General Counter-Strike related discussion.', 'crosshair', 4],
      ['Premium lounge', 'Feedback', 'Report a bug, or suggest a feature here.', 'feedback', 5],
      ['Premium lounge', 'Marketplace', 'A place for community projects and services.', 'market', 6],
      ['Development', 'Lua scripts', 'Discuss scripting, share ideas and find useful resources.', 'code', 7],
      ['Development', 'Configurations', 'Share your setup and make it your own.', 'sliders', 8]
    ].forEach(values => addForum.run(...values));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const topicSelect = 'SELECT t.*, u.username AS author, (SELECT role FROM user_roles WHERE user_id=u.id) AS author_role, (SELECT expires FROM memberships WHERE user_id=u.id) AS author_expires, (SELECT r.role FROM posts p2 LEFT JOIN user_roles r ON r.user_id=p2.author_id WHERE p2.topic_id=t.id ORDER BY p2.id DESC LIMIT 1) AS last_author_role, (SELECT m.expires FROM posts p2 LEFT JOIN memberships m ON m.user_id=p2.author_id WHERE p2.topic_id=t.id ORDER BY p2.id DESC LIMIT 1) AS last_author_expires, f.name AS forum, (SELECT count(*) FROM posts WHERE topic_id=t.id)-1 AS replies, (SELECT u2.username FROM posts p2 JOIN users u2 ON u2.id=p2.author_id WHERE p2.topic_id=t.id ORDER BY p2.id DESC LIMIT 1) AS last_author FROM topics t JOIN users u ON u.id=t.author_id JOIN forums f ON f.id=t.forum_id ';
const rates = new Map();
function checkRate(req) {
  const key = req.socket.remoteAddress;
  const entry = rates.get(key);
  if (entry && entry.until > now()) { if (entry.count >= 30) throw errors(429, '尝试次数过多，请在 15 分钟后重试。'); entry.count++; }
  else rates.set(key, {count: 1, until: now() + 900000});
}
async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw errors(413, '提交的内容过大。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw errors(400, '请求无效。'); }
}
function send(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
function makeSession(res, userId = null, remember = false) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  const maxAge = remember ? 2592000 : 86400;
  db.prepare('INSERT INTO sessions (token,csrf,user_id,expires) VALUES (?,?,?,?)').run(hashToken(token), csrf, userId, now() + maxAge * 1000);
  res.setHeader('Set-Cookie', 'gs_local=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge + (process.env.GS_SECURE_COOKIE === '1' ? '; Secure' : ''));
  return {user: userId ? publicUser(userId) : null, csrf, auth: authConfig()};
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')));
function currentSession(req) {
  const token = cookies(req).gs_local;
  return token ? db.prepare('SELECT s.* FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND (s.user_id IS NULL OR u.disabled=0)').get(hashToken(token), now()) : null;
}
function validateWrite(req, session, mime='application/json') {
  const origin = req.headers.origin;
  if (origin) { let url; try { url = new URL(origin); } catch { throw errors(403, '请求来源无效。'); } if (url.host !== req.headers.host) throw errors(403, '请求来源无效。'); }
  if (!req.headers['content-type']?.startsWith(mime)) throw errors(415, '请使用 JSON 格式提交请求。');
  if (!session || req.headers['x-csrf-token'] !== session.csrf) throw errors(403, '登录状态已过期，请刷新页面后重试。');
}
function requireUser(session) { if (!session?.user_id) throw errors(401, '请先登录后继续。'); return session.user_id; }
function text(value, min, max, label) { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw errors(400, label + '长度须为 ' + min + '～' + max + ' 个字符。'); return value.trim(); }
function validEmail(value) { return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }
function emailCodeHash(email, code) { return hashToken(email.toLowerCase() + ':' + code + ':' + EMAIL_CODE_SECRET); }
async function verifyTurnstile(token) {
  if (!TURNSTILE_ENABLED) return;
  if (typeof token !== 'string' || !token.trim()) throw errors(400, '请完成人机验证。');
  let response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({secret: TURNSTILE_SECRET_KEY, response: token})
    });
  } catch { throw errors(502, '人机验证服务暂时不可用，请稍后重试。'); }
  if (!response.ok) throw errors(502, '人机验证服务暂时不可用，请稍后重试。');
  let result; try { result = await response.json(); } catch { throw errors(502, '人机验证服务返回无效结果。'); }
  if (!result.success) throw errors(400, '人机验证未通过，请重试。');
}
async function sendVerificationEmail(email, code) {
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: 'xfcode 邮箱验证码',
        text: '你的 xfcode 注册验证码是：' + code + '\n验证码 10 分钟内有效。如非本人操作，请忽略此邮件。',
        html: '<p>你的 xfcode 注册验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">' + code + '</p><p>验证码 10 分钟内有效。如非本人操作，请忽略此邮件。</p>'
      })
    });
  } catch { throw errors(502, '邮件服务暂时不可用，请稍后重试。'); }
  if (!response.ok) { console.error('邮箱验证码发送失败，Resend 状态码：' + response.status); throw errors(502, '邮件发送失败，请检查邮箱地址后重试。'); }
}
function checkEmailCode(email) {
  const time = now();
  db.prepare('DELETE FROM email_codes WHERE expires<? OR used=1').run(time);
  const recent = db.prepare('SELECT created FROM email_codes WHERE email=? ORDER BY created DESC LIMIT 6').all(email);
  if (recent[0] && time - recent[0].created < EMAIL_CODE_COOLDOWN) throw errors(429, '验证码发送过于频繁，请稍后再试。');
  if (recent.filter(row => time - row.created < 3600000).length >= 5) throw errors(429, '该邮箱今日验证码请求次数过多，请稍后再试。');
}
function consumeEmailCode(email, code) {
  if (!EMAIL_VERIFICATION_ENABLED) return;
  if (!/^\d{6}$/.test(code)) throw errors(400, '邮箱验证码格式不正确。');
  const record = db.prepare('SELECT * FROM email_codes WHERE email=? AND used=0 ORDER BY created DESC LIMIT 1').get(email);
  if (!record || record.expires <= now()) throw errors(400, '邮箱验证码无效或已过期。');
  if (record.attempts >= EMAIL_CODE_MAX_ATTEMPTS) throw errors(400, '邮箱验证码尝试次数过多，请重新发送。');
  db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE id=?').run(record.id);
  const expected = Buffer.from(record.code_hash, 'hex');
  const actual = Buffer.from(emailCodeHash(email, code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw errors(400, '邮箱验证码不正确。');
  db.prepare('UPDATE email_codes SET used=1 WHERE id=?').run(record.id);
}
function assertTopic(id) { const row = db.prepare('SELECT * FROM topics WHERE id=?').get(id); if (!row) throw errors(404, '找不到此主题。'); return row; }

const PUBLIC_PAGE_ROUTES = new Set(['/forums/login.php','/forums/register.php','/forums/forget.php']);
const FORUM_PAGE_ROUTE = /^\/forums\/(index|preview|login|register|viewforum|viewtopic|search|profile|saved|rules|about|post|forget|subscription|downloads|chat|admin)\.php$/;
function redirectToLogin(req,res) {
  const requested = req.url?.startsWith('/forums/') ? req.url : '/forums/index.php';
  res.writeHead(302, {'Location':'/forums/login.php?from=' + encodeURIComponent(requested), 'Cache-Control':'no-store'});
  res.end();
}

const profiles = installProfiles({db,send,errors,requireUser,jsonBody,publicUser});
const features = await installFeatures({db,DATA,send,errors,now,publicUser,requireUser,jsonBody,text,hashToken,currentSession});

const adminBootstrap = await bootstrapAdmin({
  db,
  username: process.env.BOOTSTRAP_ADMIN_USERNAME,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  email: process.env.BOOTSTRAP_ADMIN_EMAIL,
});
if (adminBootstrap?.created) console.log('Bootstrap administrator created.');
else if (adminBootstrap) console.log('Bootstrap administrator credentials refreshed.');

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const method = req.method;
    if (route.startsWith('/avatars/')) { await profiles.handle(req,res,url,currentSession(req)); return; }
    if (route.startsWith('/downloads/')) { await features.download(req,res,url,currentSession(req)); return; }
    if (route.startsWith('/api/')) {
      let session = currentSession(req);
      if (method === 'GET' && route === '/api/session') { send(res,200,session ? {user: session.user_id ? publicUser(session.user_id) : null, csrf:session.csrf, auth:authConfig()} : makeSession(res)); return; }
      if (!['/api/login','/api/register','/api/email/send-code'].includes(route) && !session?.user_id) throw errors(401,'请先登录后继续。');
      if (method !== 'GET') validateWrite(req, session,route==='/api/admin/releases'?'application/octet-stream':'application/json');
      if(await profiles.handle(req,res,url,session)) return;
      if(await features.handle(req,res,url,session)) return;
      if (method === 'POST' && route === '/api/email/send-code') {
        if (!EMAIL_VERIFICATION_ENABLED) throw errors(503, '邮箱验证尚未配置。');
        checkRate(req); const body = await jsonBody(req);
        const email = text(body.email, 3, 254, '邮箱').toLowerCase();
        if (!validEmail(email)) throw errors(400, '请输入有效的邮箱地址。');
        if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw errors(409, '该邮箱已被注册。');
        await verifyTurnstile(body.turnstileToken);
        checkEmailCode(email);
        const code = String(randomInt(0, 1000000)).padStart(6, '0');
        const created = now();
        const id = Number(db.prepare('INSERT INTO email_codes (email,code_hash,expires,created) VALUES (?,?,?,?)').run(email,emailCodeHash(email,code),created + EMAIL_CODE_TTL,created).lastInsertRowid);
        try { await sendVerificationEmail(email, code); } catch (error) { db.prepare('DELETE FROM email_codes WHERE id=?').run(id); throw error; }
        send(res,200,{ok:true,expiresIn:EMAIL_CODE_TTL / 1000}); return;
      }
      if (method === 'POST' && route === '/api/register') {
        checkRate(req); const body = await jsonBody(req);
        await verifyTurnstile(body.turnstileToken);
        const username = text(body.username, 3, 25, '账号');
        if (!/^[a-z0-9]+$/i.test(username)) throw errors(400, '账号只能包含英文字母和数字。');
        const email = text(body.email, 3, 254, '邮箱').toLowerCase();
        if (!validEmail(email)) throw errors(400, '请输入有效的邮箱地址。');
        if (EMAIL_VERIFICATION_ENABLED) consumeEmailCode(email, text(body.emailCode || '', 6, 6, '邮箱验证码'));
        if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 256) throw errors(400,'密码长度须为 10～256 位。');
        if (body.password !== body.confirm) throw errors(400,'两次输入的密码不一致。');
        if (!['Asia/Shanghai','UTC','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Asia/Tokyo','Australia/Sydney'].includes(body.timezone)) throw errors(400, '请选择有效的时区。');
        if (!['public','form','private'].includes(body.privacy)) throw errors(400, '请选择有效的隐私选项。');
        const salt = randomBytes(16).toString('hex');
        const password = salt + ':' + Buffer.from(await derive(body.password,salt,64)).toString('hex');
        let id; try { id = Number(db.prepare('INSERT INTO users (username,email,password,timezone,privacy,email_verified,created) VALUES (?,?,?,?,?,?,?)').run(username,email,password,body.timezone,body.privacy,1,now()).lastInsertRowid); } catch (error) { if (String(error).includes('UNIQUE')) throw errors(409,'该账号或邮箱已被注册。'); throw error; }
        db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);
        features.ensureOwner();
        send(res,201,makeSession(res,id)); return;
      }
      if (method === 'POST' && route === '/api/login') {
        checkRate(req); const body = await jsonBody(req); await verifyTurnstile(body.turnstileToken);
        const username = text(body.username,1,25,'账号');
        if (typeof body.password !== 'string' || body.password.length > 256) throw errors(400,'请输入密码。');
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        const [salt, digest] = (user?.password || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
        const actual = Buffer.from(await derive(body.password,salt,64));
        if (!user?.password || user.disabled || !timingSafeEqual(Buffer.from(digest,'hex'), actual)) throw errors(401,'账号或密码不正确。');
        db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);
        send(res,200,makeSession(res,user.id,Boolean(body.remember))); return;
      }
      if (method === 'POST' && route === '/api/logout') { features.closeSession(session.token); db.prepare('DELETE FROM sessions WHERE token=?').run(session.token); send(res,200,makeSession(res)); return; }
      if (method === 'GET' && route === '/api/boards') {
        const forums = db.prepare('SELECT f.*, (SELECT count(*) FROM topics WHERE forum_id=f.id) AS topics, (SELECT count(*) FROM posts p JOIN topics t ON t.id=p.topic_id WHERE t.forum_id=f.id) AS posts FROM forums f ORDER BY sort').all();
        forums.forEach(f => { f.latest = db.prepare(topicSelect + 'WHERE t.forum_id=? ORDER BY t.updated DESC LIMIT 1').get(f.id) || null; });
        send(res,200,{forums,recent:db.prepare(topicSelect+'ORDER BY t.pinned DESC,t.updated DESC LIMIT 8').all(),stats:{users:db.prepare('SELECT count(*) AS n FROM users').get().n,topics:db.prepare('SELECT count(*) AS n FROM topics').get().n,posts:db.prepare('SELECT count(*) AS n FROM posts').get().n,newest:db.prepare('SELECT username FROM users ORDER BY id DESC LIMIT 1').get().username,newestUser:db.prepare("SELECT u.username,r.role,m.expires AS subscriptionExpires FROM users u LEFT JOIN user_roles r ON r.user_id=u.id LEFT JOIN memberships m ON m.user_id=u.id ORDER BY u.id DESC LIMIT 1").get()}}); return;
      }
      if (method === 'GET' && route === '/api/search') { requireUser(session);
        const q = (url.searchParams.get('q') || '').trim().slice(0,100);
        const escaped = q.replace(/[!%_]/g, '!$&');
        const results = q ? db.prepare(topicSelect + "WHERE t.title LIKE ? ESCAPE '!' OR EXISTS (SELECT 1 FROM posts p WHERE p.topic_id=t.id AND p.body LIKE ? ESCAPE '!') ORDER BY t.updated DESC LIMIT 100").all('%' + escaped + '%','%' + escaped + '%') : db.prepare(topicSelect + 'ORDER BY t.updated DESC LIMIT 100').all();
        send(res,200,{results,q}); return;
      }
      if (method === 'GET' && route === '/api/saved') { const id = requireUser(session); send(res,200,{topics:db.prepare(topicSelect + 'JOIN saved s ON s.topic_id=t.id WHERE s.user_id=? ORDER BY t.updated DESC').all(id)}); return; }
      if (method === 'GET' && route === '/api/profile') {
        const viewer=requireUser(session);let id=viewer;
        if(url.searchParams.has('id')){const raw=url.searchParams.get('id');if(!/^[1-9]\d*$/.test(raw))throw errors(400,'用户编号无效。');id=Number(raw);}
        else if(url.searchParams.has('username'))id=db.prepare('SELECT id FROM users WHERE username=?').get(url.searchParams.get('username'))?.id;
        const user=id?publicUser(id):null;if(!user)throw errors(404,'用户不存在。');
        send(res,200,{user,canEdit:id===viewer,contacts:profiles.contacts(id),posts:db.prepare('SELECT count(*) AS n FROM posts WHERE author_id=?').get(id).n,topics:db.prepare(topicSelect+'WHERE t.author_id=? ORDER BY t.created DESC').all(id)});return;
      }
      const forumMatch = route.match(/^\/api\/forums\/(\d+)$/);
      if (forumMatch && method === 'GET') { requireUser(session); const forum = db.prepare('SELECT * FROM forums WHERE id=?').get(db.prepare('SELECT new_id FROM forum_aliases WHERE old_id=?').get(forumMatch[1])?.new_id||forumMatch[1]); if (!forum) throw errors(404,'找不到此版块。'); send(res,200,{forum,topics:db.prepare(topicSelect + 'WHERE t.forum_id=? ORDER BY t.pinned DESC,t.updated DESC').all(forum.id)}); return; }
      const topicMatch = route.match(/^\/api\/topics\/(\d+)$/);
      if (topicMatch && method === 'GET') { requireUser(session);
        const id = topicMatch[1]; assertTopic(id);
        const topic = db.prepare(topicSelect + 'WHERE t.id=?').get(id);
        topic.saved = Boolean(session?.user_id && db.prepare('SELECT 1 FROM saved WHERE user_id=? AND topic_id=?').get(session.user_id,id));
        const posts = db.prepare("SELECT p.*,u.username,(SELECT '/avatars/'||u.id||'?v='||avatar_version FROM user_profiles WHERE user_id=u.id) AS avatarUrl,u.created AS joined,coalesce(r.role,'member') AS role,(SELECT expires FROM memberships WHERE user_id=u.id) AS subscriptionExpires,(SELECT count(*) FROM posts WHERE author_id=u.id) AS user_posts FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN user_roles r ON r.user_id=u.id WHERE p.topic_id=? ORDER BY p.id").all(id);
        send(res,200,{topic,posts}); return;
      }
      if (method === 'POST' && route === '/api/topics') {
        const author = requireUser(session); const body = await jsonBody(req);
        if (!Number.isSafeInteger(Number(body.forumId)) || !db.prepare('SELECT id FROM forums WHERE id=?').get(Number(body.forumId))) throw errors(404,'请选择有效的版块。');
        const title = text(body.title,3,120,'标题'); const content = text(body.body,2,20000,'内容'); const time = now();
        db.exec('BEGIN'); let id;
        try { id=Number(db.prepare('INSERT INTO topics (forum_id,author_id,title,created,updated) VALUES (?,?,?,?,?)').run(Number(body.forumId),author,title,time,time).lastInsertRowid); db.prepare('INSERT INTO posts (topic_id,author_id,body,created) VALUES (?,?,?,?)').run(id,author,content,time); db.exec('COMMIT'); } catch(error) {db.exec('ROLLBACK'); throw error;}
        send(res,201,{id}); return;
      }
      const replyMatch = route.match(/^\/api\/topics\/(\d+)\/replies$/);
      if (replyMatch && method === 'POST') { const author = requireUser(session); const topic = assertTopic(replyMatch[1]); const body = await jsonBody(req); const content = text(body.body,2,20000,'内容'); const time=now(); db.prepare('INSERT INTO posts (topic_id,author_id,body,created) VALUES (?,?,?,?)').run(topic.id,author,content,time); db.prepare('UPDATE topics SET updated=? WHERE id=?').run(time,topic.id); send(res,201,{ok:true}); return; }
      const saveMatch = route.match(/^\/api\/topics\/(\d+)\/save$/);
      if (saveMatch && method === 'POST') { const user = requireUser(session); const topic = assertTopic(saveMatch[1]); const exists = db.prepare('SELECT 1 FROM saved WHERE user_id=? AND topic_id=?').get(user,topic.id); if(exists) db.prepare('DELETE FROM saved WHERE user_id=? AND topic_id=?').run(user,topic.id); else db.prepare('INSERT INTO saved VALUES (?,?)').run(user,topic.id); send(res,200,{saved:!exists}); return; }
      throw errors(404,'接口不存在。');
    }
    if (!['GET','HEAD'].includes(method)) throw errors(405,'不支持此请求方式。');
    const files = {'/styles.css':['styles.css','text/css; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/assets/raleway-latin.woff2':['assets/raleway-latin.woff2','font/woff2'],'/assets/OFL.txt':['assets/OFL.txt','text/plain; charset=utf-8'],'/assets/favicon.svg':['assets/favicon.svg','image/svg+xml']};
    const entry = files[route];
    if (!entry && route !== '/' && !/^\/forums\/(index|preview|login|register|viewforum|viewtopic|search|profile|saved|rules|about|post|forget|subscription|downloads|chat|admin)\.php$/.test(route)) throw errors(404,'页面不存在。');
    if ((route === '/' || FORUM_PAGE_ROUTE.test(route)) && !PUBLIC_PAGE_ROUTES.has(route) && !currentSession(req)?.user_id) { redirectToLogin(req,res); return; }
    const data = await readFile(path.join(PUBLIC,entry ? entry[0] : 'index.html'));
    res.writeHead(200,{'Content-Type':entry ? entry[1] : 'text/html; charset=utf-8','Cache-Control':'no-cache'}); res.end(method === 'HEAD' ? undefined : data);
  } catch (error) { if (!res.headersSent) send(res,error.status || 500,{error:error.status ? error.message : '操作失败，请稍后重试。'}); else res.end(); if(!error.status) console.error(error); }
});
const PORT = Number(process.env.PORT || 4173);
server.listen(PORT,process.env.HOST || '0.0.0.0',()=>console.log('xfcode 本地社区： http://localhost:' + server.address().port + '/forums/index.php'));
function shutdown() {features.shutdown();server.close(()=>{db.close();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
