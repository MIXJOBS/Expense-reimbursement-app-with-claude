import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// apps/api は開発時 http://localhost:3000 で起動する想定（.env.example の PORT=3000 と対応）。
// フロントから /api 配下を呼ぶと、開発サーバーが apps/api にプロキシする。
// Cookieセッション認証を使うため、将来的にフロント側のfetchは credentials: 'include' が必須になる。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
