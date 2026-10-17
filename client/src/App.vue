<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { io } from 'socket.io-client';

const socket = io(); // 同源连接，开发时走 Vite 代理

const STORAGE_KEY = 'zerotalk_token';
const savedToken = localStorage.getItem(STORAGE_KEY);

// 预设兴趣标签（与后端保持一致）
const INTERESTS = ['音乐', '电影', '游戏', '运动', '美食', '旅行', '阅读', '宠物', '摄影', '动漫'];

// 预设头像（与后端保持一致）
const AVATARS = ['😀', '😎', '🥰', '🤗', '🦊', '🐱', '🐼', '🐯', '🦁', '🐸', '🌟', '🔥'];

// 界面状态机：login 登录 / chat 公共聊天 / matching 匹配中 / dm 私聊
const view = ref('login');

const nickname = ref('');
const nicknameInput = ref('');
const gender = ref('male');
const cityInput = ref('');
const city = ref('');
const selectedInterests = ref([]);

const rooms = ref([]);
const currentRoom = ref('');
const messages = ref([]);
const users = ref([]);
const contacts = ref([]);
const messageInput = ref('');

const peer = ref(null); // 私聊对象 { nickname, gender, city }
const distance = ref(null);
const chatListRef = ref(null);
const dmListRef = ref(null);
const matchTimedOut = ref(false);
const lastPrefer = ref('opposite');

const profile = ref(null); // 个人资料
const tab = ref('rooms'); // 左栏标签：rooms 房间 / me 我的
const showEditProfile = ref(false);
const editForm = ref({ username: '', nickname: '', gender: 'male', age: '', bio: '', contact: '', avatar: '😀' });
const fileInput = ref(null);

const currentRoomName = computed(() => {
  const r = rooms.value.find((r) => r.id === currentRoom.value);
  return r ? `${r.emoji} ${r.name}` : '';
});

onMounted(() => {
  socket.on(
    'nickname-set',
    ({ nickname: name, token, gender: g, users: list, history, rooms: roomList, room, contacts: contactList, profile: prof }) => {
      nickname.value = name;
      gender.value = g;
      users.value = list;
      localStorage.setItem(STORAGE_KEY, token);
      rooms.value = roomList || [];
      contacts.value = contactList || [];
      profile.value = prof || null;
      currentRoom.value = room;
      messages.value = history || [];
      view.value = 'chat';
      scrollToBottom();
    }
  );

  socket.on('resume-failed', () => localStorage.removeItem(STORAGE_KEY));

  socket.on('users-update', (list) => (users.value = list));

  socket.on('message', (msg) => {
    messages.value.push(msg);
    scrollToBottom();
  });

  socket.on('system-message', (msg) => {
    messages.value.push({ ...msg, system: true });
    scrollToBottom();
  });

  socket.on('room-joined', ({ room, history, users: list }) => {
    currentRoom.value = room;
    messages.value = history || [];
    users.value = list;
    scrollToBottom();
  });

  socket.on('match-waiting', () => {
    view.value = 'matching';
  });

  socket.on('match-timeout', () => {
    matchTimedOut.value = true;
  });

  socket.on('match-success', ({ peer: p, distance: d, history }) => {
    matchTimedOut.value = false;
    peer.value = p;
    distance.value = d;
    messages.value = history || [];
    view.value = 'dm';
    scrollToBottom();
  });

  socket.on('dm-opened', ({ peer: p, distance: d, history }) => {
    peer.value = p;
    distance.value = d;
    messages.value = history || [];
    view.value = 'dm';
    scrollToBottom();
  });

  socket.on('profile-updated', (prof) => {
    profile.value = prof;
    nickname.value = prof.nickname;
    gender.value = prof.gender;
    showEditProfile.value = false;
  });

  socket.on('match-cancelled', () => {
    matchTimedOut.value = false;
    view.value = 'chat';
  });

  socket.on('match-ended', ({ reason, users: list, history, contacts: contactList }) => {
    peer.value = null;
    distance.value = null;
    messages.value = history || [];
    users.value = list;
    contacts.value = contactList || contacts.value;
    currentRoom.value = 'lobby';
    view.value = 'chat';
    messages.value.push({
      text: reason === 'peer-disconnected' ? '对方已离开，匹配结束' : '匹配已结束',
      time: Date.now(),
      system: true,
    });
    scrollToBottom();
  });

  // 若本地保存了会话 token，连接后自动恢复身份
  if (savedToken) {
    const tryResume = () => socket.emit('resume', { token: savedToken });
    if (socket.connected) tryResume();
    else socket.once('connect', tryResume);
  }
});

onBeforeUnmount(() => socket.disconnect());

function join() {
  const name = nicknameInput.value.trim();
  if (!name) return;
  city.value = cityInput.value.trim();
  socket.emit('set-nickname', {
    nickname: name,
    gender: gender.value,
    city: city.value,
    interests: selectedInterests.value,
    token: localStorage.getItem(STORAGE_KEY),
  });
  requestLocation(); // 异步上报定位，不阻塞进入
}

function requestLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) =>
      socket.emit('update-location', {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      }),
    () => {},
    { timeout: 5000 }
  );
}

function startMatch(prefer) {
  lastPrefer.value = prefer;
  matchTimedOut.value = false;
  socket.emit('start-match', { prefer });
}

function retryMatch() {
  matchTimedOut.value = false;
  socket.emit('start-match', { prefer: lastPrefer.value });
}

function backToChat() {
  matchTimedOut.value = false;
  view.value = 'chat';
}

function toggleInterest(name) {
  const i = selectedInterests.value.indexOf(name);
  if (i >= 0) selectedInterests.value.splice(i, 1);
  else if (selectedInterests.value.length < 10) selectedInterests.value.push(name);
}

function cancelMatch() {
  socket.emit('cancel-match');
}

function endMatch() {
  socket.emit('end-match');
}

function send() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('message', { text });
  messageInput.value = '';
}

function switchRoom(roomId) {
  if (roomId === currentRoom.value) return;
  socket.emit('join-room', roomId);
}

function openDm(peerToken) {
  socket.emit('open-dm', { peerToken });
}

function openEditProfile() {
  const p = profile.value || {};
  editForm.value = {
    username: p.username || '',
    nickname: p.nickname || '',
    gender: p.gender || 'male',
    age: p.age != null ? String(p.age) : '',
    bio: p.bio || '',
    contact: p.contact || '',
    avatar: p.avatar || '😀',
  };
  showEditProfile.value = true;
}

function saveProfile() {
  socket.emit('update-profile', {
    username: editForm.value.username,
    nickname: editForm.value.nickname,
    gender: editForm.value.gender,
    age: editForm.value.age,
    bio: editForm.value.bio,
    contact: editForm.value.contact,
    avatar: editForm.value.avatar,
  });
}

function isImageAvatar(a) {
  return typeof a === 'string' && a.startsWith('/uploads/');
}

function triggerUpload() {
  fileInput.value?.click();
}

function onAvatarFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  compressImage(file)
    .then((dataUrl) =>
      fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      }).then((r) => r.json())
    )
    .then((data) => {
      if (data.url) editForm.value.avatar = data.url;
    })
    .catch(() => {});
  e.target.value = ''; // 允许重复选择同一文件
}

function compressImage(file, maxW = 200, maxH = 200) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function scrollToBottom() {
  nextTick(() => {
    const el = chatListRef.value || dmListRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function genderText(g) {
  return g === 'female' ? '♀ 女' : '♂ 男';
}

function distanceText() {
  return distance.value != null ? `相距 ${distance.value} km` : '距离未知';
}
</script>

<template>
  <!-- 登录界面 -->
  <div v-if="view === 'login'" class="login">
    <div class="login-box">
      <div class="logo">💬 零语</div>
      <h1>欢迎来到聊天室</h1>
      <p>设置昵称和性别，开始聊天交友</p>

      <div class="field">
        <label>昵称</label>
        <input
          v-model="nicknameInput"
          placeholder="你的昵称（最多 20 字）"
          maxlength="20"
          autofocus
          @keyup.enter="join"
        />
      </div>

      <div class="field">
        <label>性别</label>
        <div class="gender-picker">
          <button :class="{ active: gender === 'male' }" @click="gender = 'male'">
            ♂ 男
          </button>
          <button :class="{ active: gender === 'female' }" @click="gender = 'female'">
            ♀ 女
          </button>
        </div>
      </div>

      <div class="field">
        <label>所在城市（可选）</label>
        <input v-model="cityInput" placeholder="例如：上海" maxlength="20" @keyup.enter="join" />
      </div>

      <div class="field">
        <label>兴趣爱好（多选，可选）</label>
        <div class="interest-picker">
          <button
            v-for="tag in INTERESTS"
            :key="tag"
            :class="{ active: selectedInterests.includes(tag) }"
            @click="toggleInterest(tag)"
          >
            {{ tag }}
          </button>
        </div>
      </div>

      <button class="primary" @click="join" :disabled="!nicknameInput.trim()">进入</button>
    </div>
  </div>

  <!-- 匹配等待界面 -->
  <div v-else-if="view === 'matching'" class="matching">
    <div class="matching-box">
      <template v-if="!matchTimedOut">
        <div class="spinner"></div>
        <h2>正在为你寻找匹配对象…</h2>
        <p>配对成功会自动进入私聊</p>
        <button class="ghost" @click="cancelMatch">取消匹配</button>
      </template>
      <template v-else>
        <div class="timeout-icon">⏳</div>
        <h2>暂时没匹配到合适的对象</h2>
        <p>可以重新匹配，或回到聊天室</p>
        <div class="timeout-actions">
          <button class="primary" @click="retryMatch">重新匹配</button>
          <button class="ghost" @click="backToChat">返回聊天室</button>
        </div>
      </template>
    </div>
  </div>

  <!-- 私聊界面 -->
  <div v-else-if="view === 'dm'" class="dm">
    <header class="dm-header">
      <div class="dm-peer">
        <div class="avatar">
          <img v-if="peer.avatar && isImageAvatar(peer.avatar)" :src="peer.avatar" class="avatar-img" alt="" />
          <span v-else>{{ peer.avatar || peer.nickname.slice(0, 1) }}</span>
        </div>
        <div class="dm-peer-info">
          <div class="dm-peer-name">{{ peer.nickname }}</div>
          <div class="dm-peer-meta">
            <span>{{ genderText(peer.gender) }}</span>
            <span v-if="peer.city">📍 {{ peer.city }}</span>
            <span>{{ distanceText() }}</span>
          </div>
        </div>
      </div>
      <button class="ghost" @click="endMatch">结束匹配</button>
    </header>

    <div class="messages" ref="dmListRef">
      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="{ system: m.system, mine: m.nickname === nickname }"
      >
        <div v-if="m.system" class="system-text">{{ m.text }}</div>
        <template v-else>
          <div class="msg-meta">
            <span class="nick">{{ m.nickname }}</span>
            <span class="time">{{ formatTime(m.time) }}</span>
          </div>
          <div class="bubble">{{ m.text }}</div>
        </template>
      </div>
    </div>

    <div class="input-bar">
      <input
        v-model="messageInput"
        :placeholder="`发消息给 ${peer.nickname}…`"
        maxlength="500"
        @keyup.enter="send"
      />
      <button @click="send" :disabled="!messageInput.trim()">发送</button>
    </div>
  </div>

  <!-- 公共聊天主界面：三栏布局 -->
  <div v-else class="chat">
    <!-- 左栏：匹配入口 + 房间列表 -->
    <aside class="sidebar-left">
      <div class="logo">💬 零语</div>

      <!-- 房间标签：频道 + 匹配 + 会话 -->
      <template v-if="tab === 'rooms'">
        <div class="match-entry">
          <div class="section-title">💘 匹配陌生人</div>
          <button class="match-btn" @click="startMatch('opposite')">异性匹配</button>
          <button class="match-btn match-btn-ghost" @click="startMatch('random')">随机匹配</button>
        </div>

        <div class="section-title">频道</div>
        <div
          v-for="room in rooms"
          :key="room.id"
          class="room"
          :class="{ active: room.id === currentRoom }"
          @click="switchRoom(room.id)"
        >
          {{ room.emoji }} {{ room.name }}
        </div>

        <div class="section-title">会话</div>
        <div
          v-for="c in contacts"
          :key="c.peer_token"
          class="room contact"
          @click="openDm(c.peer_token)"
        >
          <span class="contact-avatar">
            <img v-if="isImageAvatar(c.peer_avatar)" :src="c.peer_avatar" class="contact-img" alt="" />
            <span v-else>{{ c.peer_avatar || c.peer_nickname.slice(0, 1) }}</span>
          </span>
          <span class="contact-name">{{ c.peer_nickname }}</span>
          <span class="contact-gender">{{ genderText(c.peer_gender) }}</span>
        </div>
        <div v-if="!contacts.length" class="empty-contacts">还没有匹配过的人</div>
      </template>

      <!-- 我的标签：个人资料 -->
      <template v-else>
        <div class="profile-view">
          <div class="profile-avatar">
            <img v-if="profile && isImageAvatar(profile.avatar)" :src="profile.avatar" class="avatar-img" alt="头像" />
            <span v-else>{{ (profile && profile.avatar) || '😀' }}</span>
          </div>
          <div class="profile-nickname">{{ nickname }}</div>

          <div class="profile-list">
            <div class="profile-row"><span class="profile-label">用户名</span><span class="profile-value">{{ profile?.username || '未设置' }} <span :class="gender === 'male' ? 'gender-male' : 'gender-female'">{{ gender === 'male' ? '♂' : '♀' }}</span></span></div>
            <div class="profile-row"><span class="profile-label">昵称</span><span class="profile-value">{{ profile?.nickname }}</span></div>
            <div class="profile-row"><span class="profile-label">性别</span><span class="profile-value">{{ genderText(gender) }}</span></div>
            <div class="profile-row"><span class="profile-label">年龄</span><span class="profile-value">{{ profile?.age || '未设置' }}</span></div>
            <div class="profile-row"><span class="profile-label">个人简介</span><span class="profile-value">{{ profile?.bio || '未填写' }}</span></div>
            <div class="profile-row"><span class="profile-label">联系方式</span><span class="profile-value">{{ profile?.contact || '未填写' }}</span></div>
          </div>

          <button class="primary" @click="openEditProfile">编辑资料</button>
        </div>
      </template>

      <!-- 底部导航 -->
      <div class="bottom-nav">
        <button :class="{ active: tab === 'rooms' }" @click="tab = 'rooms'">💬 房间</button>
        <button :class="{ active: tab === 'me' }" @click="tab = 'me'">👤 我的</button>
      </div>
    </aside>

    <!-- 中栏：聊天区 -->
    <main class="main">
      <header class="chat-header">
        <span class="chat-title">{{ currentRoomName }}</span>
        <span class="chat-subtitle">和 {{ users.length }} 位用户在线畅聊</span>
      </header>

      <div class="messages" ref="chatListRef">
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg"
          :class="{ system: m.system, mine: m.nickname === nickname }"
        >
          <div v-if="m.system" class="system-text">{{ m.text }}</div>
          <template v-else>
            <div class="msg-meta">
              <span class="nick">{{ m.nickname }}</span>
              <span class="time">{{ formatTime(m.time) }}</span>
            </div>
            <div class="bubble">{{ m.text }}</div>
          </template>
        </div>
      </div>

      <div class="input-bar">
        <input
          v-model="messageInput"
          placeholder="输入消息，回车发送…"
          maxlength="500"
          @keyup.enter="send"
        />
        <button @click="send" :disabled="!messageInput.trim()">发送</button>
      </div>
    </main>

    <!-- 右栏：在线用户 -->
    <aside class="sidebar-right">
      <div class="section-title">在线用户 · {{ users.length }}</div>
      <ul class="user-list">
        <li v-for="(u, i) in users" :key="i">
          <span class="dot"></span>
          <span class="user-name">{{ u }}</span>
          <span v-if="u === nickname" class="me-tag">我</span>
        </li>
      </ul>
    </aside>
  </div>

  <!-- 编辑资料弹窗 -->
  <div v-if="showEditProfile" class="modal-overlay" @click.self="showEditProfile = false">
    <div class="modal-box">
      <h2>编辑资料</h2>

      <div class="field">
        <label>头像</label>
        <div class="avatar-edit-row">
          <div class="avatar-preview">
            <img v-if="isImageAvatar(editForm.avatar)" :src="editForm.avatar" class="avatar-img" alt="预览" />
            <span v-else>{{ editForm.avatar }}</span>
          </div>
          <button class="ghost" type="button" @click="triggerUpload">上传图片</button>
          <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onAvatarFile" />
        </div>
        <div class="avatar-picker">
          <button
            v-for="a in AVATARS"
            :key="a"
            :class="{ active: editForm.avatar === a }"
            @click="editForm.avatar = a"
          >{{ a }}</button>
        </div>
      </div>

      <div class="field">
        <label>用户名</label>
        <input v-model="editForm.username" placeholder="用户名" maxlength="20" />
      </div>

      <div class="field">
        <label>昵称</label>
        <input v-model="editForm.nickname" placeholder="昵称" maxlength="20" />
      </div>

      <div class="field">
        <label>性别</label>
        <div class="gender-picker">
          <button :class="{ active: editForm.gender === 'male' }" @click="editForm.gender = 'male'">♂ 男</button>
          <button :class="{ active: editForm.gender === 'female' }" @click="editForm.gender = 'female'">♀ 女</button>
        </div>
      </div>

      <div class="field">
        <label>年龄</label>
        <input v-model="editForm.age" type="number" min="1" max="120" placeholder="年龄" />
      </div>

      <div class="field">
        <label>个人简介</label>
        <textarea v-model="editForm.bio" placeholder="介绍一下自己…" maxlength="200" rows="3"></textarea>
      </div>

      <div class="field">
        <label>联系方式</label>
        <input v-model="editForm.contact" placeholder="例如：微信 / QQ" maxlength="50" />
      </div>

      <div class="modal-actions">
        <button class="primary" @click="saveProfile" :disabled="!editForm.nickname.trim()">保存</button>
        <button class="ghost" @click="showEditProfile = false">取消</button>
      </div>
    </div>
  </div>
</template>
