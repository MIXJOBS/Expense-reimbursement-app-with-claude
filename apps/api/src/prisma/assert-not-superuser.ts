// 本番扱いの環境では、DB接続ユーザーがスーパーユーザーなら起動を止める。
// 本番扱いの判定は common/config/is-production-env.ts（NODE_ENV が development・test の
// どちらでもない場合。未設定を含む）。
// 監査ログの追記専用トリガーは、スーパーユーザー・テーブル所有者なら無効化できるため
// （docs/api/pbi-6.md「追記専用の担保」）、アプリは権限を絞ったロールで接続する必要がある。
// 開発・テストでは止めない（docker-compose の POSTGRES_USER がスーパーユーザーのため）。
import { isProductionEnv } from '../common/config/is-production-env';

export interface RawQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

export async function assertNotSuperuserInProduction(
  client: RawQueryClient,
): Promise<void> {
  if (!isProductionEnv()) {
    return;
  }
  // is_superuser は接続中のロールがスーパーユーザーかどうかを 'on' / 'off' で返す。
  const rows = await client.$queryRaw<{ is_superuser: string }[]>`
    SELECT current_setting('is_superuser') AS is_superuser
  `;
  // 判定できない場合も安全側（起動しない）に倒す。
  if (rows[0]?.is_superuser !== 'off') {
    throw new Error(
      'Refusing to start: the database user must not be a superuser in production ' +
        '(any NODE_ENV other than "development" or "test", including unset). ' +
        'Use a restricted application role (see docs/ops/production-db-roles.md).',
    );
  }
}
