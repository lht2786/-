import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));

// 消息表（id 自增，room 记录所属房间，time 存毫秒时间戳）
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    nickname TEXT NOT NULL,
    text TEXT NOT NULL,
    time INTEGER NOT NULL
  )
`);

// 迁移：旧版本的表没有 room 字段，补上（旧消息归入 lobby）
const cols = db.prepare('PRAGMA table_info(messages)').all();
if (!cols.some((c) => c.name === 'room')) {
  db.exec("ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT 'lobby'");
}

// 联系人表：记录「匹配过/聊过」的人，双向各存一条（含对方信息快照）
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    token TEXT NOT NULL,
    peer_token TEXT NOT NULL,
    peer_nickname TEXT NOT NULL,
    peer_gender TEXT NOT NULL,
    peer_city TEXT,
    PRIMARY KEY (token, peer_token)
  )
`);

// 迁移：旧的联系人表补充 peer_avatar 字段
const contactCols = db.prepare('PRAGMA table_info(contacts)').all();
if (!contactCols.some((c) => c.name === 'peer_avatar')) {
  db.exec('ALTER TABLE contacts ADD COLUMN peer_avatar TEXT');
}

// 用户资料表（token 为主键，持久化个人资料）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    username TEXT,
    gender TEXT NOT NULL,
    age INTEGER,
    bio TEXT,
    contact TEXT,
    city TEXT,
    avatar TEXT,
    interests TEXT
  )
`);

// 插入一条消息，返回自增 id
export function insertMessage(room, nickname, text, time) {
  const info = db
    .prepare(
      'INSERT INTO messages (room, nickname, text, time) VALUES (?, ?, ?, ?)'
    )
    .run(room, nickname, text, time);
  return Number(info.lastInsertRowid);
}

// 取某房间最近 limit 条历史消息，按时间正序返回
export function getHistory(room, limit = 50) {
  const rows = db
    .prepare(
      'SELECT id, nickname, text, time FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?'
    )
    .all(room, limit);
  return rows.reverse();
}

// 记录（或更新）一个联系人关系
export function addContact(token, peerToken, peerNickname, peerGender, peerCity, peerAvatar) {
  db.prepare(
    'INSERT OR REPLACE INTO contacts (token, peer_token, peer_nickname, peer_gender, peer_city, peer_avatar) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(token, peerToken, peerNickname, peerGender, peerCity, peerAvatar);
}

// 获取某用户的联系人列表（最近联系的在前）
export function getContacts(token) {
  return db
    .prepare(
      'SELECT peer_token, peer_nickname, peer_gender, peer_city, peer_avatar FROM contacts WHERE token = ? ORDER BY rowid DESC'
    )
    .all(token);
}

// 保存/更新用户资料
export function upsertUser(token, profile) {
  db.prepare(
    `INSERT INTO users (token, nickname, username, gender, age, bio, contact, city, avatar, interests)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       nickname = excluded.nickname,
       username = excluded.username,
       gender = excluded.gender,
       age = excluded.age,
       bio = excluded.bio,
       contact = excluded.contact,
       city = excluded.city,
       avatar = excluded.avatar,
       interests = excluded.interests`
  ).run(
    token,
    profile.nickname,
    profile.username,
    profile.gender,
    profile.age,
    profile.bio,
    profile.contact,
    profile.city,
    profile.avatar,
    JSON.stringify(profile.interests || [])
  );
}

// 获取用户资料（不存在返回 null）
export function getUserProfile(token) {
  const row = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!row) return null;
  return { ...row, interests: JSON.parse(row.interests || '[]') };
}
