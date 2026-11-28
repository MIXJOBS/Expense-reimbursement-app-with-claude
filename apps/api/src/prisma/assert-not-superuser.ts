// 本番（NODE_ENV=production）では、DB接続ユーザーがスーパーユーザーなら起動を止める。
// 監査ログの追記専用トリガーは、スーパーユーザー・テーブル所有者なら無効化できるため
// （docs/api/pbi-6.md「追記専用の担保」）、アプリは権限を絞ったロールで接続する必要がある。
// 開発・テストでは止めない（docker-compose の POSTGRES_USER がスーパーユーザーのため）。
export interface RawQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

export async function assertNotSuperuserInProduction(
  client: RawQueryClient,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  if (nodeEnv !== 'production') {
    return;
  }
  // is_superuser は接続中のロールがスーパーユーザーかどうかを 'on' / 'off' で返す。
  const rows = await client.$queryRaw<{ is_superuser: string }[]>`
    SELECT current_setting('is_superuser') AS is_superuser
  `;
  // 判定できない場合も安全側（起動しない）に倒す。
  if (rows[0]?.is_superuser !== 'off') {
    throw new Error(
      'Refusing to start: the database user must not be a superuser in production. ' +
        'Use a restricted application role (see docs/api/pbi-6.md).',
    );
  }
}
