import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 开发时把 WebSocket 请求转发到后端，前端即可同源连接
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
      '/upload': {
        target: 'http://localhost:3000',
      },
      '/uploads': {
        target: 'http://localhost:3000',
      },
    },
  },
});
