# 本番のDBロール分離の手順

本番環境では、この手順でDBロールを分けることが**必須**。監査ログ（`audit_logs`）の追記専用を守るため。
背景は`docs/api/pbi-6.md`の「追記専用の担保」を参照。

この文書には実際のパスワードや接続文字列を書かない。

## なぜ必要か

`audit_logs`の追記専用トリガーは、次の手段で無効化・回避できる。

| 手段 | 実行できるロール |
| --- | --- |
| `SET session_replication_role = replica`（既定のトリガーが発火しなくなる） | スーパーユーザー、またはこのパラメータの`SET`権限を付与されたロール（PostgreSQL 15以降の`GRANT SET ON PARAMETER`） |
| `ALTER TABLE audit_logs DISABLE TRIGGER`／`DROP TRIGGER` | テーブルの所有者、スーパーユーザー |
| `DROP TABLE audit_logs` | テーブルの所有者、スキーマの所有者、スーパーユーザー |
| `CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()`で関数の中身を空にする | 関数の所有者、スーパーユーザー |

所有者の権限は、所有者ロールのメンバーにも及び得る。

## 分けるロール

| ロール | 用途 | 条件 |
| --- | --- | --- |
| `expense_migrator`（マイグレーション用） | `prisma migrate deploy`だけに使う。アプリの実行時には使わない | データベースとテーブルの所有者 |
| `expense_app`（アプリ用） | アプリの`DATABASE_URL` | 下の条件をすべて満たす |

アプリ用ロールの条件は次のとおり。

- スーパーユーザーではない。`SET`権限（`GRANT SET ON PARAMETER`）も持たない。
- テーブル・関数・スキーマ・データベースの所有者にしない。
- **他のどのロールのメンバーにもしない。** `expense_migrator`はもちろん、`pg_write_all_data`などの定義済みロールも含む。メンバーになると、下で絞った権限を超える権限が使えるようになる。
- `audit_logs`は`SELECT`・`INSERT`のみ。`_prisma_migrations`の権限は与えない。

## 前提

- **新規の本番データベース`expense`**を想定する。空のデータベース`expense`は作成済みとする。
- PostgreSQL 16を想定する。
- SQLは`psql`で流す。途中で失敗したら止まるように、`ON_ERROR_STOP`を有効にする。

### 既存のデータベースを引き継ぐ場合（この手順だけでは足りない）

- PostgreSQL 14以前で作ったデータベースを引き継ぐと、`PUBLIC`に`public`スキーマの`CREATE`が残る場合がある。`REVOKE CREATE ON SCHEMA public FROM PUBLIC;`が必要になる。
- スーパーユーザーでマイグレーション済みのデータベースは、テーブルと関数の所有者を`expense_migrator`に移し替える必要がある。この手順には含まれない。
- どちらの場合も、手順を別途検討してから適用し、最後に「4. 確認」を実施する。

## 手順

### 1. ロールを作る

管理者（スーパーユーザー）が、`psql`で`expense`に接続して実行する。

```sql
\set ON_ERROR_STOP on

BEGIN;
CREATE ROLE expense_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE expense_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE expense OWNER TO expense_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO expense_migrator;
COMMIT;
```

続けて、同じ`psql`でパスワードを設定する。1行ずつ実行し、表示される入力欄に強いパスワードを入れる。

```
\password expense_migrator
\password expense_app
```

`CREATE ROLE ... PASSWORD '...'`は使わない。DBのログ（`log_statement`）や`psql`の履歴に、パスワードが平文で残り得るため。`\password`は、`psql`側でハッシュ化してから送る。パスワードは本番の秘密管理で保管し、リポジトリや手順書に書かない。

### 2. マイグレーションを実行する

`DATABASE_URL`を`expense_migrator`の接続先にして実行する。接続文字列は本番の秘密管理から環境変数で渡し、コマンドの引数やファイルに直接書かない。

```
pnpm --filter @expense/api prisma:migrate:deploy
```

### 3. アプリ用ロールに権限を付ける

管理者が、`psql`で`expense`に接続して実行する。**必ず`BEGIN`から`COMMIT`までをまとめて流す。** 途中で失敗したときに、`GRANT`だけが反映されて後ろの`REVOKE`が抜けた状態になるのを防ぐため。

```sql
\set ON_ERROR_STOP on

BEGIN;

GRANT CONNECT ON DATABASE expense TO expense_app;
GRANT USAGE ON SCHEMA public TO expense_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO expense_app;

-- 監査ログは INSERT・SELECT のみ（UPDATE・DELETE・TRUNCATE・TRIGGER を与えない）
REVOKE ALL ON TABLE audit_logs FROM expense_app;
GRANT SELECT, INSERT ON TABLE audit_logs TO expense_app;

-- マイグレーションの管理表はアプリから触らせない
REVOKE ALL ON TABLE "_prisma_migrations" FROM expense_app;

-- 以後のマイグレーションで作る表への既定の権限（下の「注意」を参照）
ALTER DEFAULT PRIVILEGES FOR ROLE expense_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO expense_app;

COMMIT;
```

対話中の`psql`に貼り付けた場合は、`ON_ERROR_STOP`を有効にしていても後続の入力は止まらないことがある。その場合も`BEGIN`の中で失敗すれば全体が取り消される（`COMMIT`の結果が`ROLLBACK`と表示される）。エラーが出たら原因を直して、`BEGIN`から流し直す。

ファイルに保存して流す場合は、`psql -v ON_ERROR_STOP=1 -f <ファイル>`のように実行する（接続の指定は環境に合わせて足す）。

### 4. 確認する

アプリをアプリ用ロールに切り替える前に、管理者が`expense`に接続して実行する。起動時チェックはスーパーユーザーしか検出しないため、手順の漏れや誤りはここで確認する。1つでも期待と違えば、先に進まない。

```sql
-- (1) すべて f（false）になること
--     権限をカンマで並べた has_table_privilege は、どれか1つでも持っていれば t になる
SELECT has_table_privilege('expense_app', 'public.audit_logs', 'UPDATE, DELETE, TRUNCATE, TRIGGER') AS audit_logs_mutation;
SELECT has_table_privilege('expense_app', 'public._prisma_migrations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS migrations_table;
SELECT has_parameter_privilege('expense_app', 'session_replication_role', 'SET') AS set_replication_role;
SELECT has_schema_privilege('expense_app', 'public', 'CREATE') AS schema_create;
SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_roles WHERE rolname = 'expense_app';

-- (2) 0件になること（他のロールのメンバーになっていない）
SELECT roleid::regrole FROM pg_auth_members WHERE member = 'expense_app'::regrole;

-- (3) 所有者がすべて expense_migrator であること
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public';
SELECT proname, proowner::regrole FROM pg_proc WHERE proname = 'audit_logs_reject_mutation';

-- (4) 両方 t（true）になること（監査ログの記録と閲覧に必要）
SELECT has_table_privilege('expense_app', 'public.audit_logs', 'SELECT') AS can_select,
       has_table_privilege('expense_app', 'public.audit_logs', 'INSERT') AS can_insert;
```

### 5. アプリを切り替える

本番のアプリの`DATABASE_URL`を`expense_app`にする。

## 注意（以後のマイグレーションと権限の変更）

- `ALTER DEFAULT PRIVILEGES`により、`expense_migrator`が**後で作る表には、`expense_app`の`UPDATE`・`DELETE`が自動で付く。** 次の場合は、対象の表に`audit_logs`と同じ制限（`REVOKE ALL`のあと`GRANT SELECT, INSERT`）をかけ直し、「4. 確認」をやり直す。
  - 追記専用の表を増やすとき
  - `audit_logs`を作り直すとき
  - `audit_logs`をパーティション化するとき。親表の制限は、子表を直接操作する場合には効かない。子表すべてにも制限が必要で、子表を追加するたびに必要になる。
- 手順3の`ON ALL TABLES`の`GRANT`をもう一度流した場合は、`audit_logs`と`_prisma_migrations`の`REVOKE`以降も必ず流し直す（手順3を`BEGIN`から`COMMIT`までまとめて流せばよい）。

## 起動時チェックとの関係

本番扱いの環境（`NODE_ENV`が`development`・`test`のどちらでもない場合。未設定を含む）では、DB接続ユーザーがスーパーユーザーだとAPIは起動しない。
このチェックは、所有者、`SET`権限、ロールのメンバーシップまでは検出しない。この手順と「4. 確認」で守る。

## この手順の範囲外

docker-composeの2ロール化と、本番デプロイでの接続の分離（ロール作成と`migrate deploy`の自動化）は、本番デプロイを作るときに行う。

## 検証状況

2026-11-28に、ローカルのdocker composeのPostgreSQL 16.16で、使い捨てのデータベースと使い捨てのロール（名前を置き換えたもの）を使って確認した。確認後、作ったデータベースとロールは削除した。本番環境では**未実行**。

確認できたこと：

- 手順1、手順3、「4. 確認」のSQLは、`psql`に標準入力で流してエラーなく実行でき、確認結果はすべて期待どおりだった。
- `\password`でのパスワード設定後、両ロールでパスワード認証により接続できた（端末を使わず、標準入力から値を渡した。対話画面の入力欄は未確認）。
- 手順2の`migrate deploy`はマイグレーション用ロールで成功した。
- アプリ用ロールで、seed、本番扱い（`NODE_ENV`未設定）でのAPI起動、ログイン、監査ログの閲覧、ログアウトが成功した。経費申請・承認・ロール変更のAPIは、このロールでは**未確認**。
- アプリ用ロールでは、`audit_logs`の`UPDATE`・`DELETE`・`TRUNCATE`・`DISABLE TRIGGER`・`DROP TABLE`、`SET session_replication_role`、トリガー関数の置き換え、`_prisma_migrations`の参照、表の作成がすべて拒否された。
- マイグレーション用ロールで後から作った表には、アプリ用ロールの`UPDATE`・`DELETE`が自動で付いた（「注意」のとおり）。
- `current_setting('is_superuser')`は、両ロールで`off`、管理者（スーパーユーザー）で`on`だった。

確認していないこと：既存データベースの引き継ぎ、パーティション化した場合、`psql -f`での実行、対話画面への貼り付け。
