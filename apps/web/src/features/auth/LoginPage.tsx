// ログイン画面。
//
// バリデーション方針：
// - サーバー側（LoginDto: @IsEmail, @MinLength(1)）が最終的な検証を行うため、
//   フロント側では「未入力のまま送信させない」程度のHTML標準バリデーション
//   （input type="email" + required）のみを行い、独自の正規表現やパスワード強度
//   チェックは実装しない（CLAUDE.md: 入力はサーバー側で検証し、フロントのチェック
//   だけに頼らない）。
// - パスワード違い・存在しないユーザー・ロックアウト中は、すべて同一の
//   401 AUTH_INVALID_CREDENTIALS として返ってくる（docs/api/pbi-1-2.md）。
//   フロント側でロック中かどうかを判別するような特別な分岐は行わず、
//   常に同じエラーメッセージをそのまま表示する。
import { useState, type FormEvent } from 'react';
import { useAuth } from './useAuth';
import { ApiError } from '../../lib/apiClient';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setSubmitting(true);

    try {
      await login({ email, password });
    } catch (error) {
      // サーバーが返すエラーコードに応じて分岐せず、常に同一の文言を表示する
      // （docs/api/pbi-1-2.md「認証失敗レスポンスの統一」。ロック中かどうかを
      // フロント側で区別する実装はしない）。
      if (error instanceof ApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(
          'ログインに失敗しました。時間をおいて再度お試しください。',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h1>経費精算システム ログイン</h1>

        <label htmlFor="email">メールアドレス</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />

        <label htmlFor="password">パスワード</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />

        {errorMessage && (
          <p role="alert" className="auth-error">
            {errorMessage}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'ログイン中…' : 'ログイン'}
        </button>
      </form>
    </div>
  );
}
