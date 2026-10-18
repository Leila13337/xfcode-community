import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'scripts', 'reset-accounts.mjs');
const password = 'RegressionOnlyPassword2026';
const envFor = data => ({
  ...process.env,
  GS_DATA_DIR: data,
  LEILA_ADMIN_EMAIL: 'owner@example.test',
  LEILA_ADMIN_PASSWORD: password,
});

function invoke(data, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: envFor(data),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function createFixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      privacy TEXT NOT NULL DEFAULT 'private',
      email_verified INTEGER NOT NULL DEFAULT 1 CHECK(email_verified IN (0,1)),
      created INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
    );
    CREATE TABLE sessions(token TEXT PRIMARY KEY, csrf TEXT NOT NULL, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE forums(id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL, sort INTEGER NOT NULL);
    CREATE TABLE topics(id INTEGER PRIMARY KEY, forum_id INTEGER NOT NULL REFERENCES forums(id), author_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE posts(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE saved(user_id INTEGER REFERENCES users(id), topic_id INTEGER REFERENCES topics(id), PRIMARY KEY(user_id, topic_id));
    CREATE TABLE email_codes(id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
    CREATE TABLE user_roles(user_id INTEGER PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL);
    CREATE TABLE memberships(user_id INTEGER PRIMARY KEY REFERENCES users(id), expires INTEGER NOT NULL DEFAULT 0, trial_used INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
    CREATE TABLE subscription_orders(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, activated INTEGER);
    CREATE TABLE subscription_codes(id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, tail TEXT NOT NULL, plan TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL, redeemed_by INTEGER REFERENCES users(id), redeemed INTEGER);
    CREATE TABLE subscription_events(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, plan TEXT NOT NULL, days INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE releases(id INTEGER PRIMARY KEY, title TEXT NOT NULL, version TEXT NOT NULL, filename TEXT NOT NULL, disk_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT NOT NULL, notes TEXT NOT NULL, members_only INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
    CREATE TABLE download_events(id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases(id), user_id INTEGER REFERENCES users(id), created INTEGER NOT NULL);
    CREATE TABLE chat_messages(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE user_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id), avatar BLOB, avatar_version TEXT, contacts TEXT NOT NULL DEFAULT '{}');

    INSERT INTO users(id,username,email,password,created,disabled) VALUES
      (1,'Leila','leila-old@example.test','salt:oldhash',1000,0),
      (2,'Mira','mira@example.test','salt:hash2',1001,0),
      (3,'Kai','kai@example.test','salt:hash3',1002,1);
    INSERT INTO forums(id,category,name,description,icon,sort) VALUES(1,'Community','Community','Forum','chat',1);
    INSERT INTO topics(id,forum_id,author_id,title,created,updated) VALUES
      (10,1,2,'Mira topic',100,101),
      (11,1,1,'Leila topic',102,103);
    INSERT INTO posts(id,topic_id,author_id,body,created) VALUES
      (20,10,2,'Mira starter',100),
      (21,10,1,'Leila reply',101),
      (22,11,3,'Kai reply',103);
    INSERT INTO saved(user_id,topic_id) VALUES(2,10),(1,10);
    INSERT INTO sessions(token,csrf,user_id,expires) VALUES('s1','c1',1,999999),( 's2','c2',2,999999);
    INSERT INTO email_codes(id,email,code_hash,expires,created) VALUES(1,'pending@example.test','hash',999999,100);
    INSERT INTO user_roles(user_id,role) VALUES(1,'member'),(2,'administrator'),(3,'member');
    INSERT INTO memberships(user_id,expires,trial_used,updated) VALUES(1,999999,0,100),(2,888888,1,100);
    INSERT INTO subscription_orders(id,user_id,plan,status,created) VALUES('ORDER-1',2,'monthly','pending',100);
    INSERT INTO subscription_codes(id,hash,tail,plan,created_by,created,redeemed_by,redeemed) VALUES(1,'codehash','ABCD','monthly',2,100,3,200);
    INSERT INTO subscription_events(id,user_id,source,plan,days,expires,created) VALUES(1,2,'code','monthly',30,999999,100);
    INSERT INTO releases(id,title,version,filename,disk_name,size,sha256,notes,created) VALUES(1,'Release','1','release.zip','disk.bin',1,'hash','notes',100);
    INSERT INTO download_events(id,release_id,user_id,created) VALUES(1,1,2,100);
    INSERT INTO chat_messages(id,user_id,body,created) VALUES(1,2,'Mira chat',100),(2,1,'Leila chat',101);
    INSERT INTO user_profiles(user_id,contacts) VALUES(1,'{}'),(2,'{"qq":"123"}'),(3,'{}');
  `);
  db.close();
}

test('account reset dry-run is inert; confirmed run keeps exactly one hashed administrator and preserves referential integrity', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'xfcode-reset-test-'));
  const file = path.join(data, 'forum.sqlite');
  try {
    createFixture(file);

    const preview = invoke(data, ['--dry-run']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /删除其他可登录账号：2 个/);
    assert.match(preview.stdout, /预览模式，数据库未更改/);
    assert.doesNotMatch(preview.stdout, new RegExp(password));

    let db = new DatabaseSync(file);
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE password<>''").get().n, 3);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
    db.close();

    const missingConfirmation = invoke(data, ['--apply']);
    assert.notEqual(missingConfirmation.status, 0);
    assert.match(missingConfirmation.stderr, /未更改数据库/);

    const applied = invoke(data, ['--apply', '--confirm-delete-other-accounts']);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(applied.stdout, /唯一可登录账号为 Leila/);
    assert.doesNotMatch(applied.stdout, new RegExp(password));
    const backupPath = applied.stdout.match(/^数据库备份：(.+)$/m)?.[1]?.trim();
    assert.ok(backupPath, applied.stdout);
    assert.ok((await stat(backupPath)).size > 0);

    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    const liveUsers = db.prepare("SELECT id,username,email,password,disabled FROM users WHERE password<>''").all();
    assert.equal(liveUsers.length, 1);
    assert.equal(liveUsers[0].username, 'Leila');
    assert.equal(liveUsers[0].email, 'owner@example.test');
    assert.equal(liveUsers[0].disabled, 0);
    const [salt, digest] = liveUsers[0].password.split(':');
    const expectedDigest = await promisify(scrypt)(password, salt, 64);
    assert.deepEqual(Buffer.from(digest, 'hex'), expectedDigest);
    assert.equal(db.prepare('SELECT role FROM user_roles WHERE user_id=?').get(liveUsers[0].id).role, 'administrator');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM user_profiles WHERE user_id=2 OR user_id=3').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memberships WHERE user_id=2 OR user_id=3').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM subscription_orders').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM subscription_events').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM saved WHERE user_id IN (2,3)').get().n, 0);
    assert.equal(db.prepare('SELECT user_id FROM download_events WHERE id=1').get().user_id, null);
    const tombstone = db.prepare("SELECT id FROM users WHERE password='' AND disabled=1 AND email LIKE 'deleted-users+%@invalid.local'").get();
    assert.ok(tombstone);
    assert.equal(db.prepare('SELECT author_id FROM topics WHERE id=10').get().author_id, tombstone.id);
    assert.equal(db.prepare('SELECT body FROM posts WHERE id=21').get().body, 'Leila reply');
    assert.equal(db.prepare('SELECT author_id FROM posts WHERE id=20').get().author_id, tombstone.id);
    assert.equal(db.prepare('SELECT user_id FROM chat_messages WHERE id=1').get().user_id, tombstone.id);
    const code = db.prepare('SELECT created_by,redeemed_by FROM subscription_codes WHERE id=1').get();
    assert.equal(code.created_by, tombstone.id);
    assert.equal(code.redeemed_by, tombstone.id);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();

    const secondRun = invoke(data, ['--apply', '--confirm-delete-other-accounts']);
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    assert.match(secondRun.stdout, /删除其他可登录账号：0 个/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
test('reset creates Leila when the database has no Leila user', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'xfcode-reset-create-test-'));
  const file = path.join(data, 'forum.sqlite');
  try {
    createFixture(file);
    const db = new DatabaseSync(file);
    db.exec(`
      DELETE FROM saved WHERE user_id=1;
      DELETE FROM sessions WHERE user_id=1;
      DELETE FROM user_roles WHERE user_id=1;
      DELETE FROM memberships WHERE user_id=1;
      DELETE FROM user_profiles WHERE user_id=1;
      UPDATE topics SET author_id=2 WHERE author_id=1;
      UPDATE posts SET author_id=2 WHERE author_id=1;
      UPDATE chat_messages SET user_id=2 WHERE user_id=1;
      DELETE FROM users WHERE id=1;
    `);
    db.close();

    const applied = invoke(data, ['--apply', '--confirm-delete-other-accounts']);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(applied.stdout, /创建 Leila 管理员账号/);
    const check = new DatabaseSync(file);
    const liveUsers = check.prepare("SELECT id,username,email,password FROM users WHERE password<>''").all();
    assert.equal(liveUsers.length, 1);
    assert.equal(liveUsers[0].username, 'Leila');
    assert.equal(liveUsers[0].email, 'owner@example.test');
    assert.equal(check.prepare('SELECT role FROM user_roles WHERE user_id=?').get(liveUsers[0].id).role, 'administrator');
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    check.close();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});