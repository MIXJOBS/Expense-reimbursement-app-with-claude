// ホーム画面。
//
// 本PBIのスコープでは「ログイン中ユーザー情報（GET /auth/me の結果）を表示する」
// 程度の簡単な画面でよい（本格的な経費一覧等は別PBI）。
import { useState } from 'react';
import { useAuth } from '../auth/useAuth';
import type { RoleName } from '@expense/shared';

// ロールのコード値をそのまま表示すると業務ユーザーにはわかりにくいため、
// 画面表示用の日本語ラベルだけここで定義する（packages/sharedは編集しない）。
//
// 注：packages/shared/dist が CommonJS 出力（"type": "module" 未指定）のため、
// Rollup本番ビルドで RoleName を値としてimportすると名前付きexportの静的解析に
// 失敗する（CJS/ESM相互運用の制約）。そのため値は再定義せず、キーは
// RoleName型（文字列リテラルユニオン）の値そのもの（'APPLICANT'等）を直接書く。
const ROLE_LABELS: Record<RoleName, string> = {
  APPLICANT: '申請者',
  MANAGER: '上長',
  ACCOUNTING: '経理',
  ADMIN: '管理者',
};

export function HomePage() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!user) {
    // AuthProvider側の状態管理により通常は到達しないが、型上nullを許容しているため
    // 防御的に何も表示しない。
    return null;
  }

  const handleLogout = async () => {
    setErrorMessage(null);
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      setErrorMessage(
        'ログアウトに失敗しました。時間をおいて再度お試しください。',
      );
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="home-page">
      <header className="home-header">
        <h1>経費精算システム</h1>
        <button type="button" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? 'ログアウト中…' : 'ログアウト'}
        </button>
      </header>

      {errorMessage && (
        <p role="alert" className="auth-error">
          {errorMessage}
        </p>
      )}

      <section className="home-user-info">
        <h2>ログイン中のユーザー情報</h2>
        <dl>
          <dt>氏名</dt>
          <dd>{user.name}</dd>

          <dt>メールアドレス</dt>
          <dd>{user.email}</dd>

          <dt>ロール</dt>
          <dd>
            {user.roles.length > 0
              ? user.roles.map((role) => ROLE_LABELS[role] ?? role).join('、')
              : 'なし'}
          </dd>
        </dl>
      </section>
    </div>
  );
}
