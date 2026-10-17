# 零语聊天室

陌生人匿名聊天室（MVP）。技术栈：Vue 3 + Vite（前端） / Node.js + Express + Socket.IO（后端）。

## 目录结构

```
├── server/   # 后端（Express + Socket.IO）
│   └── index.js
└── client/   # 前端（Vue 3 + Vite）
    └── src/App.vue
```

## 运行

首次运行先安装依赖：

```bash
# 后端
cd server && npm install

# 前端（另开一个终端）
cd client && npm install
```

启动：

```bash
# 终端 1：启动后端（端口 3000）
cd server && npm run dev

# 终端 2：启动前端（端口 5173）
cd client && npm run dev
```

浏览器打开 http://localhost:5173 ，输入昵称即可进入公共聊天室。

## 当前功能（MVP）

- 公共大厅群聊 + 房间系统（多主题房间，消息隔离）
- 昵称设置、性别选择
- 实时消息收发、在线用户列表
- 加入/离开系统提示
- 匿名会话保持（刷新不丢身份）
- 消息历史持久化（SQLite）
- 异性 / 随机匹配私聊
- 位置与距离展示（基于浏览器定位，Haversine 计算）
- 智能匹配评分（同城优先、共同兴趣加分、30 秒超时重试）
- 私聊历史列表（匹配过的人保留为联系人，可再次聊天）
- 个人资料（头像支持 emoji 或上传图片、用户名/昵称/简介/联系方式/年龄/性别，可编辑持久化）

## 后续规划

- 未读提醒、消息通知
- 部署上线（服务器 + 备案 + 内容审核）
