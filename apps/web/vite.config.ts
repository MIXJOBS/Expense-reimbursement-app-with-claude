import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// apps/api は開発時 http://localhost:3000 で起動する想定（.env.example の PORT=3000 と対応）。
//
// apps/api 側は AuthController が @Controller('auth') のため、実際のエンドポイントは
// /auth/login・/auth/logout・/auth/me であり、/api プレフィックスは存在しない
// （/admin 配下の管理API も同様に /api プレフィックスなし）。
// そのため、フロントから叩くパスそのもの（/auth, /admin）を開発サーバーが
// apps/api にプロキシする。apiClient.ts 側も /api を付けずに fetch する実装にしている。
//
// Cookieセッション認証を使うため、フロント側のfetchは credentials: 'include' が必須
// （apiClient.ts で対応済み）。changeOrigin: true により、Vite開発サーバー経由でも
// apps/api へのリクエストの Origin ヘッダーはプロキシ先（http://localhost:3000）向けに
// 書き換えられる。CSRF対策のOrigin検証はブラウザ→Vite間のOriginで判定されるため、
// 許可オリジンに http://localhost:5173 を含める必要がある（apps/api側の設定）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
