// CSRF対策（Origin検証）・CORS設定で共通して使う「許可されたOrigin一覧」。
//
// 環境変数 ALLOWED_ORIGINS（カンマ区切り）で設定する。未設定の場合:
// - NODE_ENV=production では、許可オリジン未設定のまま本番で動くことを防ぐため、
//   assertAllowedOriginsConfigured() がアプリ起動時にエラーを発生させ、起動を止める。
// - それ以外（開発・テスト環境）では、apps/web の開発サーバ（Vite既定ポート）のみを
//   許可するデフォルト値を使う
//   （test/support/fixtures.ts の ALLOWED_ORIGIN = 'http://localhost:5173' と一致させる）。
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function getAllowedOrigins(): Set<string> {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || raw.trim() === '') {
    // production環境での未設定は起動時チェック（assertAllowedOriginsConfigured）で
    // 既に起動を止めているはずだが、呼び出され得る場合に備えて二重に防御する。
    if (isProductionEnv()) {
      throw new Error(
        'ALLOWED_ORIGINS environment variable must be set in production.',
      );
    }
    return new Set(DEFAULT_ALLOWED_ORIGINS);
  }

  const origins = parseAllowedOrigins(raw);

  return new Set(origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS);
}

// アプリ起動時（CommonModuleの初期化時）に一度だけ呼び、
// production環境でALLOWED_ORIGINSが未設定のままアプリが起動することを防ぐ。
export function assertAllowedOriginsConfigured(): void {
  const raw = process.env.ALLOWED_ORIGINS;
  const isConfigured = typeof raw === 'string' && parseAllowedOrigins(raw).length > 0;

  if (!isConfigured && isProductionEnv()) {
    throw new Error(
      'ALLOWED_ORIGINS environment variable must be set in production ' +
        '(comma-separated list of allowed origins, e.g. "https://example.com").',
    );
  }
}
