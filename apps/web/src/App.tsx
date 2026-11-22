// アプリ全体のエントリーコンポーネント。
//
// ルーティングについて：現時点では「ログイン画面」「ホーム画面」の2画面のみであり、
// react-router-dom等のルーティングライブラリは導入せず、認証状態（AuthContext）に
// 応じた出し分けのみで最低限のルーティング保護を実現する
// （未ログインでホーム画面にアクセス → GET /auth/me が401 → ログイン画面を表示）。
// 画面数が増えてURL遷移・ブラウザ履歴・ディープリンクが必要になった時点で、
// react-router-dom導入を検討する（後述の提案を参照）。
import { AuthProvider } from './features/auth/AuthContext';
import { useAuth } from './features/auth/useAuth';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';

function AppRoutes() {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="app-loading">
        <p>読み込み中…</p>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginPage />;
  }

  return <HomePage />;
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
