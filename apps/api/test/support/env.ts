// e2eテスト用の安全装置。
//
// このテストスイートは実DB（PrismaService経由）に対してUser/Role/UserRole/
// Sessionを直接作成・削除する。誤って開発用DB（expense）に向けて実行すると、
// 開発用DBのデータを汚染・破壊してしまう恐れがあるため、DATABASE_URLが
// テスト専用DB（expense_test）を指していることをここで検証し、そうでなければ
// 即座にエラーをthrowしてテストの実行を止める。
//
// DATABASE_URL自体の設定は、呼び出し側（ルートの `pnpm test:e2e:api` ＝
// `dotenv -e .env.test -- pnpm --filter @expense/api test:e2e`）が担う。
// 本ファイルは新規依存（dotenv等）を追加せず、環境変数の「検証」のみ行う。
//
// 各 e2e spec ファイルの先頭で `import './support/env';` のように読み込むこと
// （import時にこの検証が走る）。
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL が設定されていません。このテストはexpense_testデータベース専用です。' +
      '.env.testを使ってテストを実行してください（ルートから `pnpm test:e2e:api`）。',
  );
}

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');

if (databaseName !== 'expense_test') {
  throw new Error(
    `このテストはexpense_testデータベース専用です。DATABASE_URLが` +
      `"${databaseName}"を指しています（開発用DBを壊さないための安全装置）。` +
      '.env.testを使ってテストを実行してください（ルートから `pnpm test:e2e:api`）。',
  );
}
