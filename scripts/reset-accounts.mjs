import { DatabaseSync, backup } from 'node:sqlite';
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.GS_DATA_DIR || path.join(ROOT, 'data'));
const DB_PATH = path.join(DATA, 'forum.sqlite');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const validArgs = new Set(['--apply', '--confirm-delete-other-accounts', '--dry-run']);
const unexpected = [...args].filter(arg => !validArgs.has(arg));

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (unexpected.length) {
  fail(`未知参数：${unexpected.join(', ')}。`);
} else if (apply && args.has('--dry-run')) {
  fail('--apply 和 --dry-run 不能同时使用。');
} else if (apply && !args.has('--confirm-delete-other-accounts')) {
  fail('实际执行必须同时传入 --apply 和 --confirm-delete-other-accounts；未更改数据库。');
} else if (!existsSync(DB_PATH)) {
  fail(`找不到数据库：${DB_PATH}。请先启动网站完成数据库初始化。`);
} else {
  await run();
}

async function run() {
  const emailOverride = process.env.LEILA_ADMIN_EMAIL?.trim().toLowerCase() || '';
  const password = process.env.LEILA_ADMIN_PASSWORD || '';
  if (emailOverride && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOverride)) {
    return fail('LEILA_ADMIN_EMAIL 不是有效邮箱地址。');
  }
  if (password.length < 10 || password.length > 256) {
    return fail('请通过 LEILA_ADMIN_PASSWORD 提供 10～256 个字符的密码。');
  }

  const derive = promisify(scrypt);
  const salt = randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${Buffer.from(await derive(password, salt, 64)).toString('hex')}`;
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const requiredTables = [
      'users', 'sessions', 'forums', 'topics', 'posts', 'saved', 'email_codes', 'user_roles', 'memberships',
      'subscription_orders', 'subscription_codes', 'subscription_events', 'download_events',
      'chat_messages', 'user_profiles',
    ];
    const missing = requiredTables.filter(table => !tables.has(table));
    if (missing.length) return fail(`数据库结构不完整（缺少 ${missing.join(', ')}）。请先启动当前版本的网站完成初始化。`);
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
    if (!userColumns.has('disabled')) return fail('users 表缺少 disabled 字段；请先启动当前版本的网站完成数据库迁移。');

    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const users = db.prepare('SELECT id,username,email,password,disabled FROM users').all();
      const target = users.find(row => row.username.toLowerCase() === 'leila');
      const systemUser = users.find(row => row.password === '' && row.disabled === 1 && /^deleted-users\+.+@invalid\.local$/i.test(row.email));
      const removeIds = users.filter(row => row.id !== target?.id && row.id !== systemUser?.id).map(row => row.id);
      const removeSet = new Set(removeIds);
      const email = emailOverride || target?.email || 'leila-admin@invalid.local';
      const emailOwner = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
      if (emailOwner && emailOwner.id !== target?.id && !removeSet.has(emailOwner.id)) {
        db.exec('ROLLBACK');
        return fail('目标邮箱已被保留的系统账号占用；请设置一个可用的 LEILA_ADMIN_EMAIL。');
      }

      const countFor = (table, column) => removeIds.length
        ? Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} IN (${removeIds.map(() => '?').join(',')})`).get(...removeIds).n)
        : 0;
      const counts = {
        accounts: users.filter(row => removeSet.has(row.id) && row.password !== '').length,
        topics: countFor('topics', 'author_id'),
        posts: countFor('posts', 'author_id'),
        chat: countFor('chat_messages', 'user_id'),
        profiles: countFor('user_profiles', 'user_id'),
        memberships: countFor('memberships', 'user_id'),
        orders: countFor('subscription_orders', 'user_id'),
        events: countFor('subscription_events', 'user_id'),
        saved: countFor('saved', 'user_id'),
        downloads: countFor('download_events', 'user_id'),
      };
      console.log('Leila 管理员账号初始化预览：');
      console.log(`- ${target ? '更新' : '创建'} Leila 管理员账号`);
      console.log(`- 删除其他可登录账号：${counts.accounts} 个`);
      console.log(`- 保留并匿名化讨论内容：${counts.topics} 个主题、${counts.posts} 条帖子、${counts.chat} 条聊天`);
      console.log(`- 清理其他账号资料/会员/申请/订阅记录：${counts.profiles} / ${counts.memberships} / ${counts.orders} / ${counts.events}`);
      console.log(`- 删除收藏：${counts.saved} 条；下载记录匿名化：${counts.downloads} 条`);
      console.log('- 清除所有现存登录会话和邮箱验证码');
      if (!apply) {
        db.exec('ROLLBACK');
        console.log('预览模式，数据库未更改。确认后使用 --apply --confirm-delete-other-accounts 执行。');
        return;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(DATA, `forum.sqlite.before-leila-admin-reset-${stamp}.sqlite`);
      if (existsSync(backupPath)) throw new Error(`备份文件已存在，拒绝覆盖：${backupPath}`);
      const snapshot = new DatabaseSync(DB_PATH, { readOnly: true });
      try {
        await backup(snapshot, backupPath);
      } finally {
        snapshot.close();
      }

      let tombstoneId = systemUser?.id;
      if (removeIds.length && !tombstoneId) {
        const suffix = randomBytes(6).toString('hex');
        const result = db.prepare('INSERT INTO users (username,email,password,timezone,privacy,email_verified,created,disabled) VALUES (?,?,?,?,?,?,?,1)')
          .run(`DeletedUser${suffix}`, `deleted-users+${suffix}@invalid.local`, '', 'UTC', 'private', 1, Date.now());
        tombstoneId = Number(result.lastInsertRowid);
      }
      if (removeIds.length) {
        const marks = removeIds.map(() => '?').join(',');
        db.prepare(`UPDATE topics SET author_id=? WHERE author_id IN (${marks})`).run(tombstoneId, ...removeIds);
        db.prepare(`UPDATE posts SET author_id=? WHERE author_id IN (${marks})`).run(tombstoneId, ...removeIds);
        db.prepare(`UPDATE chat_messages SET user_id=? WHERE user_id IN (${marks})`).run(tombstoneId, ...removeIds);
        db.prepare(`UPDATE subscription_codes SET created_by=? WHERE created_by IN (${marks})`).run(tombstoneId, ...removeIds);
        db.prepare(`UPDATE subscription_codes SET redeemed_by=? WHERE redeemed_by IN (${marks})`).run(tombstoneId, ...removeIds);
        db.prepare(`UPDATE download_events SET user_id=NULL WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM saved WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM user_profiles WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM user_roles WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM memberships WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM subscription_orders WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM subscription_events WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM sessions WHERE user_id IN (${marks})`).run(...removeIds);
        db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...removeIds);
      }
      db.exec('DELETE FROM sessions; DELETE FROM email_codes;');

      let leilaId = target?.id;
      if (leilaId) {
        db.prepare('UPDATE users SET username=?,email=?,password=?,timezone=?,privacy=?,email_verified=1,disabled=0 WHERE id=?')
          .run('Leila', email, passwordHash, 'Asia/Shanghai', 'private', leilaId);
      } else {
        const result = db.prepare('INSERT INTO users (username,email,password,timezone,privacy,email_verified,created,disabled) VALUES (?,?,?,?,?,?,?,0)')
          .run('Leila', email, passwordHash, 'Asia/Shanghai', 'private', 1, Date.now());
        leilaId = Number(result.lastInsertRowid);
      }
      db.prepare('DELETE FROM user_roles WHERE user_id<>?').run(leilaId);
      db.prepare("INSERT INTO user_roles(user_id,role) VALUES(?,'administrator') ON CONFLICT(user_id) DO UPDATE SET role='administrator'").run(leilaId);

      const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
      if (fkErrors.length) throw new Error(`外键检查失败（${fkErrors.length} 项），事务已回滚。`);
      const loginableUsers = db.prepare("SELECT username FROM users WHERE password<>'' ORDER BY username").all();
      if (loginableUsers.length !== 1 || loginableUsers[0].username !== 'Leila') throw new Error('执行后账号校验失败，事务已回滚。');
      if (db.prepare('SELECT role FROM user_roles WHERE user_id=?').get(leilaId)?.role !== 'administrator') throw new Error('管理员权限校验失败，事务已回滚。');

      db.exec('COMMIT');
      console.log('初始化完成：唯一可登录账号为 Leila，角色为 administrator。');
      console.log(`数据库备份：${backupPath}`);
      console.log('其他账号已删除；原有主题、帖子和聊天内容保留并匿名化。');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}