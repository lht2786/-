import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { insertMessage, getHistory, addContact, getContacts, upsertUser, getUserProfile } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 预设公共房间列表
const ROOMS = [
  { id: 'lobby', name: '公共大厅', emoji: '🌐' },
  { id: 'dating', name: '交友闲聊', emoji: '💑' },
  { id: 'city', name: '同城', emoji: '📍' },
  { id: 'hobby', name: '兴趣爱好', emoji: '🎮' },
];

// 预设兴趣标签（前端登录界面也有一份，需保持一致）
const INTERESTS = ['音乐', '电影', '游戏', '运动', '美食', '旅行', '阅读', '宠物', '摄影', '动漫'];

// 预设头像（emoji）
const AVATARS = ['😀', '😎', '🥰', '🤗', '🦊', '🐱', '🐼', '🐯', '🦁', '🐸', '🌟', '🔥'];

// 匹配超时（毫秒），可通过环境变量覆盖（默认 30 秒）
const MATCH_TIMEOUT = Number(process.env.MATCH_TIMEOUT) || 30 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// 头像上传目录（静态托管）
const UPLOAD_DIR = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR));

// 头像上传接口（接收 base64 图片）
app.post('/upload', async (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl;
    if (!dataUrl) return res.status(400).json({ error: 'no dataUrl' });
    const m = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid image' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const filename = `${randomUUID()}.${ext}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(m[2], 'base64'));
    res.json({ url: `/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ error: 'upload failed' });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // 开发阶段放开，生产环境务必收紧为你的域名
  },
});

// 在线用户：socket.id -> { nickname, token, gender, city, lat, lon, room }
const onlineUsers = new Map();
// 会话：token -> { nickname, gender, city, lat, lon }
const sessions = new Map();
// 匹配队列：socket.id -> { gender, prefer }
const matching = new Map();
// 私聊关系：token -> { peerToken, roomId }
const dms = new Map();
// 匹配超时定时器：socket.id -> timer
const matchTimers = new Map();

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 首次进入 / 改名（带性别、城市、位置、资料）
  socket.on('set-nickname', (payload) => {
    const nickname =
      String(payload?.nickname || '').trim().slice(0, 20) || '匿名用户';
    const gender = payload?.gender === 'female' ? 'female' : 'male';
    const username =
      String(payload?.username || '').trim().slice(0, 20) || nickname;
    const age = toAge(payload?.age);
    const bio = String(payload?.bio || '').trim().slice(0, 200) || null;
    const contact = String(payload?.contact || '').trim().slice(0, 50) || null;
    const city = String(payload?.city || '').trim().slice(0, 20) || null;
    const avatar = normalizeAvatar(payload?.avatar);
    const lat = toCoord(payload?.lat);
    const lon = toCoord(payload?.lon);
    const interests = normalizeInterests(payload?.interests);

    let token = payload?.token;
    if (!token || !sessions.has(token)) token = randomUUID();

    const profile = {
      nickname, username, gender, age, bio, contact, city, avatar, interests, lat, lon,
    };
    sessions.set(token, profile);
    upsertUser(token, profile);

    attachUser(socket, token);
  });

  // 用 token 恢复会话（刷新页面后自动重新加入）
  socket.on('resume', (payload) => {
    const token = payload?.token;
    if (!token) {
      socket.emit('resume-failed');
      return;
    }

    let profile = sessions.get(token);
    if (!profile) {
      // 服务重启后从数据库恢复
      profile = getUserProfile(token);
      if (profile) {
        profile.lat = null;
        profile.lon = null;
        sessions.set(token, profile);
      }
    }
    if (!profile) {
      socket.emit('resume-failed');
      return;
    }
    attachUser(socket, token);
  });

  // 更新位置（浏览器定位是异步的，进入后补充上报经纬度）
  socket.on('update-location', (payload) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    u.lat = toCoord(payload?.lat);
    u.lon = toCoord(payload?.lon);
    const sess = sessions.get(u.token);
    if (sess) {
      sess.lat = u.lat;
      sess.lon = u.lon;
    }
  });

  // 更新个人资料
  socket.on('update-profile', (payload) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    const profile = sessions.get(u.token);
    if (!profile) return;

    if (payload?.nickname != null)
      profile.nickname = String(payload.nickname).trim().slice(0, 20) || profile.nickname;
    if (payload?.username != null)
      profile.username = String(payload.username).trim().slice(0, 20) || profile.username;
    if (payload?.gender != null)
      profile.gender = payload.gender === 'female' ? 'female' : 'male';
    if (payload?.age != null) profile.age = toAge(payload.age);
    if (payload?.bio != null)
      profile.bio = String(payload.bio).trim().slice(0, 200) || null;
    if (payload?.contact != null)
      profile.contact = String(payload.contact).trim().slice(0, 50) || null;
    if (payload?.avatar != null) profile.avatar = normalizeAvatar(payload.avatar);

    // 同步到在线表和数据库
    Object.assign(u, publicProfile(profile));
    upsertUser(u.token, profile);

    socket.emit('profile-updated', publicProfile(profile));
    io.to(u.room).emit('users-update', getRoomUsers(u.room));
  });

  // 切换公共房间（私聊中不允许）
  socket.on('join-room', (roomId) => {
    const u = onlineUsers.get(socket.id);
    const room = ROOMS.find((r) => r.id === roomId);
    if (!u || !room || dms.has(u.token)) return;

    const prev = socket.data.room;
    if (prev === room.id) return;

    socket.leave(prev);
    socket.join(room.id);
    u.room = room.id;
    socket.data.room = room.id;

    socket.emit('room-joined', {
      room: room.id,
      history: getHistory(room.id),
      users: getRoomUsers(room.id),
    });
    if (prev) io.to(prev).emit('users-update', getRoomUsers(prev));
    io.to(room.id).emit('users-update', getRoomUsers(room.id));
  });

  // 接收聊天消息，广播给当前房间（公共或私聊），同时入库
  socket.on('message', (payload) => {
    const u = onlineUsers.get(socket.id);
    const room = socket.data.room;
    if (!u || !room) return;

    const text = String(payload?.text || '').trim().slice(0, 500);
    if (!text) return;

    const time = Date.now();
    const id = insertMessage(room, u.nickname, text, time);
    io.to(room).emit('message', { id, nickname: u.nickname, text, time });
  });

  // 开始匹配（prefer: 'opposite' 异性 | 'random' 随机）
  socket.on('start-match', (payload) => {
    const u = onlineUsers.get(socket.id);
    if (!u || matching.has(socket.id)) return;

    const prefer = payload?.prefer === 'random' ? 'random' : 'opposite';
    matching.set(socket.id, { gender: u.gender, prefer, since: Date.now() });
    socket.emit('match-waiting');

    const peer = findMatch(socket.id);
    if (peer) {
      matching.delete(socket.id);
      matching.delete(peer.socketId);
      startPrivateChat(socket.id, peer.socketId);
      return;
    }

    // 超时未匹配到则提醒
    matchTimers.set(
      socket.id,
      setTimeout(() => {
        if (matching.has(socket.id)) {
          matching.delete(socket.id);
          matchTimers.delete(socket.id);
          socket.emit('match-timeout');
        }
      }, MATCH_TIMEOUT)
    );
  });

  // 取消匹配
  socket.on('cancel-match', () => {
    if (matching.has(socket.id)) {
      matching.delete(socket.id);
      clearMatchTimer(socket.id);
      socket.emit('match-cancelled');
    }
  });

  // 结束私聊
  socket.on('end-match', () => {
    endPrivateChat(socket.id, 'ended');
  });

  // 主动打开与某联系人的私聊（会话列表点击）
  socket.on('open-dm', (payload) => {
    const u = onlineUsers.get(socket.id);
    const peerToken = payload?.peerToken;
    if (!u || !peerToken || dms.has(u.token)) return;

    const contact = getContacts(u.token).find((c) => c.peer_token === peerToken);
    if (!contact) return;

    const roomId = dmRoomId(u.token, peerToken);
    const peerSocket = findSocketByToken(peerToken);
    const peerUser = peerSocket ? onlineUsers.get(peerSocket.id) : null;
    const distance = peerUser ? calcDistance(u.lat, u.lon, peerUser.lat, peerUser.lon) : null;
    const history = getHistory(roomId);

    moveToRoom(socket, u, roomId);
    dms.set(u.token, { peerToken, roomId });

    // 对方在线则一并拉入私聊（实时互通）
    if (peerSocket && peerUser) {
      moveToRoom(peerSocket, peerUser, roomId);
      dms.set(peerToken, { peerToken: u.token, roomId });
      peerSocket.emit('dm-opened', {
        room: roomId,
        peer: publicInfo(u),
        distance,
        history,
      });
    }

    socket.emit('dm-opened', {
      room: roomId,
      peer: {
        nickname: contact.peer_nickname,
        gender: contact.peer_gender,
        city: contact.peer_city,
      },
      distance,
      history,
    });
  });

  // 断开连接
  socket.on('disconnect', () => {
    matching.delete(socket.id);
    clearMatchTimer(socket.id);
    const u = onlineUsers.get(socket.id);
    if (!u) {
      console.log(`[断开] ${socket.id}`);
      return;
    }

    // 若正在私聊，通知对方结束
    const dm = dms.get(u.token);
    if (dm) {
      const peerSocket = findSocketByToken(dm.peerToken);
      if (peerSocket) backToLobby(peerSocket.id, 'peer-disconnected');
      dms.delete(u.token);
      dms.delete(dm.peerToken);
    }

    const { room } = u;
    onlineUsers.delete(socket.id);
    if (room) {
      io.to(room).emit('users-update', getRoomUsers(room));
      io.to(room).emit('system-message', {
        text: `${u.nickname} 离开了聊天室`,
        time: Date.now(),
      });
    }
    console.log(`[断开] ${socket.id}`);
  });
});

// 绑定用户身份到 socket，进入默认公共房间
function attachUser(socket, token) {
  const sess = sessions.get(token);
  const { nickname, gender, lat, lon } = sess;
  socket.data.nickname = nickname;
  socket.data.token = token;
  socket.data.gender = gender;

  const defaultRoom = ROOMS[0];
  socket.data.room = defaultRoom.id;
  socket.join(defaultRoom.id);
  onlineUsers.set(socket.id, {
    token,
    lat,
    lon,
    room: defaultRoom.id,
    ...publicProfile(sess),
  });

  socket.emit('nickname-set', {
    nickname,
    token,
    gender,
    profile: publicProfile(sess),
    rooms: ROOMS,
    room: defaultRoom.id,
    users: getRoomUsers(defaultRoom.id),
    history: getHistory(defaultRoom.id),
    contacts: getContacts(token),
  });
  socket.to(defaultRoom.id).emit('system-message', {
    text: `${nickname} 加入了聊天室`,
    time: Date.now(),
  });
  socket.to(defaultRoom.id).emit('users-update', getRoomUsers(defaultRoom.id));
}

// 在匹配队列中寻找与 requester 互相接受、评分最高的对象
function findMatch(socketId) {
  const req = matching.get(socketId);
  const reqUser = onlineUsers.get(socketId);
  if (!req || !reqUser) return null;

  let best = null;
  let bestScore = -1;
  for (const [sid, m] of matching) {
    if (sid === socketId) continue;
    const peer = onlineUsers.get(sid);
    if (!peer) continue;
    if (
      accepts(reqUser.gender, req.prefer, peer.gender) &&
      accepts(peer.gender, m.prefer, reqUser.gender)
    ) {
      const score = matchScore(reqUser, peer); // 同城优先、共同兴趣加分
      if (score > bestScore) {
        bestScore = score;
        best = { socketId: sid };
      }
    }
  }
  return best;
}

// 匹配评分：同城 +100，每个共同兴趣 +20
function matchScore(a, b) {
  let score = 0;
  if (a.city && b.city && a.city === b.city) score += 100;
  const common = (a.interests || []).filter((i) => (b.interests || []).includes(i)).length;
  score += common * 20;
  return score;
}

// 判断 gender 一方按 prefer 是否接受 otherGender
function accepts(gender, prefer, otherGender) {
  if (prefer === 'random') return true;
  if (!gender || !otherGender) return false;
  return gender !== otherGender;
}

// 配对成功，建立私聊房间
function startPrivateChat(sidA, sidB) {
  const a = onlineUsers.get(sidA);
  const b = onlineUsers.get(sidB);
  const socketA = io.sockets.sockets.get(sidA);
  const socketB = io.sockets.sockets.get(sidB);
  if (!a || !b || !socketA || !socketB) return;

  const roomId = dmRoomId(a.token, b.token);
  const distance = calcDistance(a.lat, a.lon, b.lat, b.lon);

  moveToRoom(socketA, a, roomId);
  moveToRoom(socketB, b, roomId);

  // 建立/更新联系人关系
  addContact(a.token, b.token, b.nickname, b.gender, b.city, b.avatar);
  addContact(b.token, a.token, a.nickname, a.gender, a.city, a.avatar);

  dms.set(a.token, { peerToken: b.token, roomId });
  dms.set(b.token, { peerToken: a.token, roomId });

  socketA.emit('match-success', {
    room: roomId,
    peer: publicInfo(b),
    distance,
    history: getHistory(roomId),
  });
  socketB.emit('match-success', {
    room: roomId,
    peer: publicInfo(a),
    distance,
    history: getHistory(roomId),
  });
}

// 结束私聊，双方回大厅
function endPrivateChat(sid, reason) {
  const u = onlineUsers.get(sid);
  if (!u) return;
  const dm = dms.get(u.token);
  if (!dm) return;

  const peerToken = dm.peerToken;
  const peerSocket = findSocketByToken(peerToken);

  dms.delete(u.token);
  dms.delete(peerToken);

  backToLobby(sid, reason);
  if (peerSocket) backToLobby(peerSocket.id, reason);
}

// 让某个 socket 回到大厅
function backToLobby(sid, reason) {
  const u = onlineUsers.get(sid);
  const s = io.sockets.sockets.get(sid);
  if (!u || !s) return;

  s.leave(u.room);
  s.join('lobby');
  u.room = 'lobby';
  s.data.room = 'lobby';

  s.emit('match-ended', {
    reason,
    room: 'lobby',
    users: getRoomUsers('lobby'),
    history: getHistory('lobby'),
    contacts: getContacts(u.token),
  });
  io.to('lobby').emit('users-update', getRoomUsers('lobby'));
}

// 生成稳定的私聊房间 id（与顺序无关）
function dmRoomId(tokenA, tokenB) {
  return `dm-${[tokenA, tokenB].sort().join('-')}`;
}

// 切换 socket 到目标房间
function moveToRoom(socket, user, roomId) {
  socket.leave(user.room);
  socket.join(roomId);
  user.room = roomId;
  socket.data.room = roomId;
}

// 根据 token 找到在线 socket
function findSocketByToken(token) {
  for (const [sid, u] of onlineUsers) {
    if (u.token === token) return io.sockets.sockets.get(sid);
  }
  return null;
}

// 返回某房间的在线昵称列表
function getRoomUsers(roomId) {
  const list = [];
  for (const u of onlineUsers.values()) {
    if (u.room === roomId) list.push(u.nickname);
  }
  return list;
}

// 对外的用户信息（不暴露精确坐标，保护隐私）
function publicInfo(u) {
  return { nickname: u.nickname, gender: u.gender, city: u.city, avatar: u.avatar };
}

// Haversine 计算两点球面距离（公里），保留 1 位小数
function calcDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toCoord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 清洗兴趣标签：只保留预设列表内、去重、限 10 个
function normalizeInterests(arr) {
  if (!Array.isArray(arr)) return [];
  return [
    ...new Set(
      arr.map((s) => String(s).trim()).filter((s) => s && INTERESTS.includes(s))
    ),
  ].slice(0, 10);
}

// 规范化头像（预设 emoji 或上传的图片 URL，否则默认）
function normalizeAvatar(a) {
  const s = String(a || '').trim();
  if (AVATARS.includes(s)) return s;
  if (s.startsWith('/uploads/')) return s;
  return '😀';
}

// 规范化年龄（1-120 的整数，否则 null）
function toAge(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : null;
}

// 对外公开的资料（不含精确坐标）
function publicProfile(p) {
  return {
    nickname: p.nickname,
    username: p.username,
    gender: p.gender,
    age: p.age,
    bio: p.bio,
    contact: p.contact,
    city: p.city,
    avatar: p.avatar,
    interests: p.interests,
  };
}

// 清除匹配超时定时器
function clearMatchTimer(socketId) {
  const t = matchTimers.get(socketId);
  if (t) {
    clearTimeout(t);
    matchTimers.delete(socketId);
  }
}

// 生产环境：托管前端构建产物（client/dist），开发时由 Vite 处理
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ 聊天服务器已启动: http://localhost:${PORT}`);
});
