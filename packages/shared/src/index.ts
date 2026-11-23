// このファイルは packages/shared の公開エントリポイントです。
// ここに、API(apps/api)とフロント(apps/web)で共有する型・定数
// （例: ロール名、申請ステータスなど）を定義し re-export していきます。
//
// PBI1（ログイン・ログアウト）・PBI2（ロールと権限）で確定した型・定数を公開します。
export * from './roles';
export * from './errors';
export * from './auth';
export * from './admin';
export * from './audit';
export * from './expenses';
