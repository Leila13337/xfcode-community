import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export async function bootstrapAdmin({ db, username, password, email }) {
  const name = typeof username === 'string' ? username.trim() : '';
  const secret = typeof password === 'string' ? password : '';
  const mail = (typeof email === 'string' ? email.trim().toLowerCase() : '') || `${name.toLowerCase()}-admin@invalid.local`;
  if (!name && !secret && !email) return null;
  if (!/^[a-z0-9]{3,25}$/i.test(name)) throw new Error('BOOTSTRAP_ADMIN_USERNAME must contain 3–25 ASCII letters or digits.');
  if (secret.length < 10 || secret.length > 256) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain 10–256 characters.');
  if (!validEmail(mail)) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address.');

  const salt = randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${Buffer.from(await derive(secret, salt, 64)).toString('hex')}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name);
    const emailOwner = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(mail);
    if (emailOwner && emailOwner.id !== existing?.id) throw new Error('BOOTSTRAP_ADMIN_EMAIL is already assigned to another account.');

    let id;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE users SET email=?,password=?,email_verified=1,disabled=0 WHERE id=?').run(mail, passwordHash, id);
    } else {
      id = Number(db.prepare('INSERT INTO users (username,email,password,timezone,privacy,email_verified,created,disabled) VALUES (?,?,?,?,?,?,?,0)')
        .run(name, mail, passwordHash, 'Asia/Shanghai', 'private', 1, Date.now()).lastInsertRowid);
    }
    db.prepare("INSERT INTO user_roles(user_id,role) VALUES(?,'administrator') ON CONFLICT(user_id) DO UPDATE SET role='administrator'").run(id);
    db.exec('COMMIT');
    return { id, created: !existing };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
