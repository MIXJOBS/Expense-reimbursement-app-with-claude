# PBI6 監査ログ 設計

PBI6（監査ログ）のAPI・テーブル・記録方式のまとめ。
設計として作成し、現在は**実装済み**（Controller／Service／マイグレーション／テスト。セキュリティレビュー指摘への対応を含む。Interceptorは使わない）。
受け入れ条件の出典は`docs/requirements/sprint-3.md`。フォーマットは`docs/api/pbi-4.md`に合わせる。
「判断が必要な点」14件には、2026-11-25にPOの回答があった（`docs/requirements/sprint-3.md`の「PO判断：PBI 6設計への回答」）。回答の反映結果は末尾の「判断が必要な点（PO回答と反映結果）」にまとめた。宿題として後回しになった項目は、同節の「宿題一覧」を参照。

## 全体方針

- **記録方式：Serviceが、業務の更新と同じトランザクション内で記録する**（Interceptorでは記録しない）。理由と却下案は「記録方式の判断」を参照。CLAUDE.md横断ルール4の文言（「Interceptorで記録する」）との食い違いは、PO承認（No.11）により、ルート`CLAUDE.md`の横断ルール4を修正済み。
- 監査ログは**追記専用**。アプリに更新・削除のコードを書かず、DBトリガーでも`UPDATE`・`DELETE`・`TRUNCATE`を拒否する。更新・削除のAPIは作らない。
- 閲覧は`GET /admin/audit-logs`のみ（ADMINだけ）。作成APIは公開しない（ログは業務操作の副作用としてだけ生まれる）。
- 状態を変える操作は、業務の更新と監査ログの記録を同じトランザクションで行う。**記録に失敗したら業務の更新も失敗させる**（500 `INTERNAL_ERROR`、内部情報は返さない）。
- 変更前後の値は**ホワイトリスト方式**で作る。パスワード・passwordHash・Cookie・セッショントークン（`tokenHash`含む）は、載せられる項目の一覧に存在しない。

## 記録項目（audit_logsテーブル）

| 列 | 型 | 内容（受け入れ条件との対応） |
| --- | --- | --- |
| `id` | uuid | 主キー |
| `occurredAt` | timestamptz(3) | **いつ**。DBの`clock_timestamp()`（INSERT実行時刻）。`now()`ではない理由は「同時実行」参照 |
| `actorUserId` | uuid? | **誰が**（操作者ID）。ログイン失敗など未認証の操作はnull。Userへの外部キーは張らない |
| `actorEmail` | varchar(254)? | **誰が**（ログイン失敗のみ。入力されたメールアドレス） |
| `action` | string | **何を**（操作の種類。`AuditAction`） |
| `result` | string | **結果**（`SUCCESS`／`FAILURE`。`AuditResult`） |
| `failureCode` | string? | `FAILURE`のときの理由（`AuditFailureCode`） |
| `targetType` | string | **何に**（対象の種類。`AuditTargetType`） |
| `targetId` | uuid? | **何に**（対象のID）。対象が特定できない場合（存在しないメールでのログイン失敗）だけnull |
| `before` / `after` | json? | **変更前後の値**。フラットなJSON・8KB以内・ホワイトリストの項目のみ |
| `ipAddress` | varchar(45)? | **IPアドレス**（`req.ip`） |

- 型・定数は`packages/shared/src/audit.ts`、モデルは`apps/api/prisma/schema.prisma`の`AuditLog`。マイグレーションは`apps/api/prisma/migrations/20261125000000_add_audit_logs/`。
- **外部キーを張らない理由（意図的）**：`targetId`は種類によって参照先が違う多態参照で、削除された申請（`EXPENSE_DELETE`）の記録も残す必要がある。`actorUserId`もUser削除経路（e2eテストの後始末の`user.deleteMany`など）とログの保持を切り離したい。値の正しさは`AuditLogService`が書き込み時に保証する。
- インデックス：`[occurredAt]`、`[actorUserId, occurredAt]`、`[actorEmail, occurredAt]`、`[targetType, targetId, occurredAt]`（閲覧APIの絞り込み・並び順に対応）。
- 並び順は`occurredAt`降順、同時刻は`id`降順（ページ間で順序が揺れないようにする）。

## 記録対象の操作一覧

「記録する条件」の列は、記録を書く条件（業務の更新が実際に成功したとき）を表す。

| 操作 | `action` | `targetType` / `targetId` | `actorUserId` | before → after | 記録する条件・同一トランザクションに入れる業務更新 |
| --- | --- | --- | --- | --- | --- |
| ログイン成功 | `LOGIN`（`SUCCESS`） | `USER` / ログインしたユーザーID | 本人 | null → null | セッション作成＋`failedLoginCount`リセットと同一Tx |
| ログイン失敗 | `LOGIN`（`FAILURE`） | `USER` / 該当ユーザーID（存在しないメールならnull） | null（`actorEmail`に入力値） | null → null | パスワード違いは`failedLoginCount`加算（ロックアウト設定を含む）と同一Tx。それ以外（存在しない・無効化済み・ロック中）は記録のみ。`failureCode`で理由を区別 |
| ログアウト | `LOGOUT` | `SESSION` / `Session.id` | 本人 | null → null | セッションのrevokeが1件成功したときだけ。revokeと同一Tx |
| ロール付与 | `ROLE_GRANT` | `USER` / 付与された側のユーザーID | 管理者 | `{roleId, roleName, granted:false}` → `{…, granted:true}` | `UserRole`が実際に新規作成されたときだけ（すでに保持していた場合は何も変わらないので記録しない。PO判断No.2で確定） |
| ロール剥奪 | `ROLE_REVOKE` | `USER` / 剥奪された側のユーザーID | 管理者 | `{…, granted:true}` → `{…, granted:false}` | `UserRole`の削除と同一Tx（既存の悲観ロックTxの中に入れる） |
| 申請の作成 | `EXPENSE_CREATE` | `EXPENSE_REQUEST` / 申請ID | 申請者 | null → 申請のスナップショット | 作成と同一Tx |
| 申請の編集 | `EXPENSE_UPDATE` | 同上 | 申請者 | 編集前 → 編集後のスナップショット | 条件付き`updateMany`が1件のとき |
| 申請の削除 | `EXPENSE_DELETE` | 同上 | 申請者 | 削除前のスナップショット → null | 条件付き`deleteMany`が1件のとき |
| 申請の提出 | `EXPENSE_SUBMIT` | 同上 | 申請者 | 提出前 → 提出後（`status`・`approverId`が変わる） | `$executeRaw`が1件のとき |
| 承認 | `EXPENSE_APPROVE` | 同上 | 承認者 | `status: SUBMITTED` → `APPROVED` ほか全項目 | 条件付き`updateMany`が1件のとき |
| 差し戻し | `EXPENSE_RETURN` | 同上 | 承認者 | `status`・`returnReason`が変わる全項目 | 条件付き`updateMany`が1件のとき |
| 領収書アップロード（PBI5） | `RECEIPT_UPLOAD` | `RECEIPT` / 領収書ID | 申請者 | null → null（暫定。PBI5の設計で決める。署名付きURL・保存パス・保存ファイル名は載せない＝No.12） | PBI5で実装。値だけ先に定義済み |
| 領収書の閲覧URL発行（PBI5） | `RECEIPT_URL_ISSUE` | `RECEIPT` / 領収書ID | 申請者または承認者 | null → null | 同上。URL本体（署名付き）は記録しない |

- **記録しないもの（PO判断で確定）**：申請の一覧・詳細などの閲覧（GET）、セッション期限切れによる自動失効、`GET /admin/audit-logs`自体の閲覧（No.5。監査ログの閲覧の記録は宿題）、権限不足（403）・404・409などログイン失敗以外の失敗（No.1。403の記録は宿題）、レート制限（429）で弾かれた試行（No.14。宿題）。
- 申請のスナップショット（ホワイトリスト）：`status`、`expenseDate`、`amount`、`category`、`description`、`approverId`、`returnReason`。`id`・`applicantId`・`createdAt`・`updatedAt`は`targetId`・`actorUserId`・`occurredAt`と重複するか不変のため載せない。`returnReason`は入力どおり（trimしない）記録する（Sprint 3持ち越し事項と整合）。
- ロール変更は、ユーザーの全ロール一覧の前後ではなく**付与・剥奪された1ロールの差分**を残す。全ロール一覧を前後で残すと、同じユーザーへの同時操作で「前」の値が実態とずれるため。差分なら「行が作られた／消えた」という事実だけなので常に正確。

## 機微情報を記録しない方法（横断ルール5）

1. **ホワイトリスト**：`packages/shared`の`AUDIT_SNAPSHOT_FIELDS`が、対象の種類ごとに載せてよい項目を固定する。実装（`AuditLogService`）は「載せる項目を選んで取り出す」関数でスナップショットを作り、Prismaの行オブジェクトをそのまま渡さない（`User`行は`passwordHash`を持つので、そのまま渡す経路自体を作らない）。ログイン・ログアウトの`before`/`after`は常にnull。
2. **キー名の二重チェック**：`AUDIT_FORBIDDEN_KEY_PATTERN`（`pass(word)`・`hash`・`token`・`cookie`・`secret`・`session`）にキー名が一致したら、記録処理が例外を投げる＝業務更新もロールバックする。ホワイトリストが正しければ発火しない、実装ミスを開発中・テストで早く気づくためのもの。
3. **値の型**：フラットなJSON（文字列・数値・真偽・null）のみ。ネストしたオブジェクト・配列は不可。サイズ上限8KB（`AUDIT_SNAPSHOT_MAX_BYTES`）。
4. **リクエストボディをそのまま保存しない**：Interceptorでリクエスト／レスポンスの本文を丸ごと保存する方式は、ログインのボディ（パスワード）が混入する典型的な事故になるため採らない（却下案の理由の一つ）。
5. **ログイン失敗の入力メールアドレス**：保存してよい唯一の「ユーザー入力そのもの」。`LoginDto`の`@IsEmail()`を通った値だけ、254文字まで。パスワードは絶対に保存しない。メール欄に誤ってパスワードを入れる事故は、メール形式の入力だけを記録するので残りのリスクは受容する（PO判断No.6）。
6. **IPアドレス**：`req.ip`。`TRUST_PROXY`が未設定だとリバースプロキシのIPになるため、デプロイ時は`TRUST_PROXY`を正しく設定する（`apps/api/src/configure-app.ts`の既存方針と同じ。偽装可能な`X-Forwarded-For`を直接信用しない）。
7. **ログ出力**：記録失敗時のアプリログにも`before`/`after`・メールアドレスを出さない（`action`・`targetType`・`targetId`・エラー種別だけ）。Prisma・DBの例外はメッセージに`data`の値（入力メール・申請の自由入力）を含み得るため、`AuditLogService.record`のcatchで、固定文言の`AuditRecordError`（`audit record failed (<エラー名> <コード>)`。元の例外はcauseにも持たない）に包み直して投げる。さらに、グローバルの`HttpExceptionFilter`は、想定外の例外のログを**エラー名・コード・スタックの位置情報（`at ...`の行）だけ**にし、例外メッセージを出さない（PO判断：PBI 6セキュリティレビュー 要修正-2）。
8. **キーのホワイトリスト検証**：`record`は`before`/`after`のキーが、対象の種類のホワイトリスト（`AUDIT_SNAPSHOT_FIELDS`）に含まれることを確認し、含まれないキーがあれば例外にする（業務更新もロールバック）。`ROLE_GRANT`・`ROLE_REVOKE`は`targetType=USER`だが`USER_ROLE`の項目で検証する。`USER`・`SESSION`・`RECEIPT`は項目が空なので、`before`/`after`は常にnull（PBI5で領収書に載せる項目を決めたら`AUDIT_SNAPSHOT_FIELDS`に足す）。

## 追記専用の担保（改ざん・削除対策）

1. **アプリ側**：`prisma.auditLog`に対する`update`・`updateMany`・`upsert`・`delete`・`deleteMany`を呼ぶコードを書かない。作成は`AuditLogService.record`内の`create`1箇所だけ。更新・削除のAPIも作らない。コードの監視として、ソースを検索して`auditLog`の更新・削除メソッド呼び出しが無いことを確認するテストがある（`apps/api/test/audit-logs.e2e-spec.ts`）。
2. **DB側（受け入れ条件）**：マイグレーションに手書きSQLで以下を追加している。`prisma migrate dev --create-only`で生成したSQLの末尾に追記した（Prismaのスキーマではトリガーを表現できないため）。

   ```sql
   CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'audit_logs is append-only (% is not allowed)', TG_OP
       USING ERRCODE = 'restrict_violation';
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER audit_logs_no_update_delete
     BEFORE UPDATE OR DELETE ON "audit_logs"
     FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

   CREATE TRIGGER audit_logs_no_truncate
     BEFORE TRUNCATE ON "audit_logs"
     FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();
   ```

   - 受け入れ条件は`UPDATE`と`DELETE`だが、`TRUNCATE`は行単位トリガーが発火せず、全件消去できてしまうため、同じ関数を文単位トリガーで追加する（PO判断No.9で採用）。
   - トリガーの例外はアプリの500になる（内部情報は返さない）。
3. **DBロールの分離（本番の必須要件）**：トリガーだけでは、次の手段で追記専用を破れる。
   - `SET session_replication_role = replica`（既定のトリガーが発火しなくなる。PostgreSQL 16以降は`SET`権限を付与されたロールも使える）
   - `ALTER TABLE ... DISABLE TRIGGER`／`DROP TRIGGER`（テーブルの所有者・スーパーユーザー）
   - `DROP TABLE`
   - `CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()`で関数の中身を空にする

   そのため本番では、次の2つのロールを**必ず分ける**。
   - **マイグレーション用ロール（テーブルの所有者）**：`prisma migrate deploy`だけに使う。アプリの実行時には使わない。
   - **アプリ用ロール**：スーパーユーザーではなく、`SET`権限（`GRANT SET ON PARAMETER`）も持たない。`audit_logs`は`INSERT`・`SELECT`のみ（`UPDATE`・`DELETE`・`TRUNCATE`・`TRIGGER`を与えない）。テーブルの所有者にしない。

   これにより、アプリ側の脆弱性（SQLインジェクション等）が起きても、監査ログの改ざん・削除ができない。アプリ用ロールを作るSQLの例は、ルートの`.env.example`のコメントに書く（PO判断。要修正-1(b)。**未反映**：`.env.example`は作業担当の権限で読み書きできないため、貼り付け案を作業報告`.reports/`に載せている）。
   - **起動時チェック（実装済み）**：`NODE_ENV=production`で、DB接続ユーザーがスーパーユーザー（`current_setting('is_superuser')`が`off`以外）なら、APIは起動を止める（`apps/api/src/prisma/assert-not-superuser.ts`、`PrismaService.onModuleInit`から呼ぶ）。開発・テストでは止めない（docker-composeの`POSTGRES_USER`がスーパーユーザーのため）。このチェックは、スーパーユーザー以外の「所有者」や`SET`権限の付与までは検出しない。ロールの設計で守る。
   - **宿題**：docker-composeの2ロール化と、本番デプロイでのロール作成・`migrate deploy`の接続分離は、本番デプロイを作るときに行う（PO判断）。
   - ハッシュチェーン（行ごとに前行のハッシュを含める改ざん検知）は、10〜50人規模では過剰として今回は見送る。
4. **テスト環境への影響（テスト担当への連絡）**：既存e2eは`user.deleteMany`等で後始末をするが、`audit_logs`にはFKがないため影響しない。一方、テストから`audit_logs`を削除・全件消去することはできなくなる。テストは、そのテストで作ったユーザー・申請のIDで絞り込んで検証する（全件数に依存しない）。テストDB全体の初期化は`migrate reset`（スキーマごと作り直し）で行う。

## 記録方式の判断：InterceptorかService内か

### 判断基準

「業務データの更新と同じトランザクションで記録できること」。更新は成功したがログが無い／ログはあるが更新が失敗した、を起こさない。受け入れ条件にも「同じトランザクションで行う。記録に失敗したら業務の更新も失敗させる」と明記されている。

### 採用案：Service内で`AuditLogService.record(tx, entry)`を呼ぶ

- 各Serviceの状態変更を`prisma.$transaction(async (tx) => { ... })`で包み、業務の更新が**実際に成功した直後**に同じ`tx`で`auditLogService.record(tx, {...})`を呼ぶ。
- `record`は`tx`（`Prisma.TransactionClient`）を必須の第1引数にする。`tx`を渡さない呼び出し口を作らない（Txの外で記録できてしまうのを型で防ぐ）。
- 呼び出し元の情報は、ControllerからServiceに引数で渡す（操作者は既存の`@CurrentUser()`、IPは`@ClientIp()`）。**このためにInterceptorは使わない**。
- 「更新が実際に成功した」判定は既存の方式をそのまま使う：
  - 承認・差し戻し・編集・削除：条件付き`updateMany`／`deleteMany`の`count`が1のときだけ`record`。0なら既存どおり409（Txはロールバック、ログは書かれない）。
  - 提出：`$executeRaw`の戻り値（影響行数）が1のときだけ`record`。0なら既存どおりの2種類の409。
  - これは**更新と記録が同じTxなので、更新が成立していないのに成功ログが残る**ことはない。
- before/afterの取り方：Txの最初に対象行を`SELECT ... FOR UPDATE`（`$queryRaw`＋`Prisma.sql`。`apps/api/src/admin/roles.service.ts`の悲観ロックと同じ流儀）でロックして読み、それを`before`にする。更新後、同じTx内で再読込したものを`after`にする。行ロックにより、読んでから更新するまでの間に他のTxが同じ行を変えることがないため、`before`・`after`は常に正確。既存の条件付き`updateMany`は残す（最終的な判定役。ロックを取った上でも二重の防御になる）。
- 既存の2段階方式（存在確認→404、条件付き更新→409）の順序・エラーコードは変えない。存在確認をTxの内側に移し、404／409を投げるとTxごとロールバックされる（`roles.service.ts`のTx内で`ForbiddenException`を投げているのと同じ）。

### 却下案

| 案 | 却下理由 |
| --- | --- |
| **A. Interceptorだけで記録**（ハンドラの後に別Txで書く） | 更新Txとログ書き込みが別Txになるため、受け入れ条件を満たせない。更新コミット後にログ書き込みが失敗すると、「更新は成功したがログが無い」か、「コミット済みの更新に500を返す」かの二択になる。さらにInterceptorは、`updateMany`が0件で409になったかどうか・変更前の値を知らない（再取得すると、取得の間に別のTxが更新して不正確になる）。リクエストボディを丸ごと保存する実装に流れやすく、ログインのパスワードが混入する危険がある。 |
| **B. InterceptorでTxを開き、AsyncLocalStorage（nestjs-cls等）でServiceにTxを暗黙共有** | 技術的には可能だが、(1) 新規依存パッケージが増える、(2) 全Serviceが「暗黙のTx」を使うPrismaラッパーに変わり、影響範囲が大きい、(3) ログインでは、Txの中でargon2のパスワード検証（重い）が走り、Tx保持時間が延びる、(4) 結局before/afterと「実際に更新できたか」はServiceが知っているため、Serviceから情報をInterceptorに渡す仕組みが別途必要になる。複雑さに見合わない。 |
| **C. DBトリガーで業務テーブルの変更を自動記録** | 同一Txは自然に満たせるが、トリガーは操作者（アプリのユーザー）・IP・ログイン失敗を知らない。セッション変数（`set_config`）で渡す手もあるが、仕組みが大きく、DB外のログイン失敗は結局アプリが書く必要がある。 |

### 採用案の弱点と対策

- **記録の呼び忘れ**（新しい状態変更を足したときにログを書き忘れる）：Interceptorなら自動だが、Service案は人手になる。対策として、(1) 記録対象一覧（本ドキュメント）をレビューの基準にする、(2) e2eで「各操作を1回実行すると、対応する`action`のログが1件増える」を操作ごとにテストする（テスト担当）、(3) `record`を呼ぶのはService層だけとし、ControllerやGuardから直接呼ばない。
- **失敗ログ（result=FAILURE）をInterceptorで補う案**（今回は不採用）：PO判断No.1により失敗の記録はログイン失敗のみ（Service内、同一Tx）。403等の記録は宿題で、将来行う場合は、業務更新が無い（Txが無い）ため、Interceptor＋`@Audited(action, targetType)`デコレータで`catchError`時に別途書く方式が成立する（失敗の記録専用で、成功の記録には使わない）。

### CLAUDE.md横断ルール4の文言変更（PO承認済み・反映済み）

変更前：

> 4. 監査ログ：誰が・いつ・何に・何をしたかと変更前後の値を、Interceptorで記録する（実装はSprint 3のPBI 6。それまでは未実装でよい）

変更後（ルート`CLAUDE.md`に反映済み。PO判断No.11）：

> 4. 監査ログ：誰が・いつ・何に・何をしたか・結果と変更前後の値を、`AuditLogService`が**業務の更新と同じトランザクション内**で記録する（Service層で明示的に呼ぶ。Interceptorでは記録しない）。記録に失敗したら業務の更新も失敗させる。追記専用（アプリから更新・削除しない＋DBトリガーで拒否）。変更前後の値はホワイトリストの項目のみで、パスワード・Cookie・トークンは載せない

併せて、`apps/api/prisma/schema.prisma`の`UserRole`のコメントと`docs/api/pbi-1-2.md`の監査ログの記述（削除した`RoleChangeAuditPayload`型への言及）は修正済み。

## 同時実行・失敗時の挙動

- **承認と差し戻しが同時に来た場合**：両方が`SELECT ... FOR UPDATE`で同じ行を取りに行き、後から来た側はロック解放まで待つ。先に進んだ側が`SUBMITTED`→`APPROVED`（または`RETURNED`）にして、監査ログ1件をINSERTしてコミットする。後の側はロックを得た時点で`status`が`SUBMITTED`ではなくなっているため、条件付き`updateMany`が0件→409→Txロールバック。**成功ログは1件だけ**、敗者のログは書かれない（PO判断No.1により、ログイン失敗以外の失敗は記録しない）。
- **編集と提出が同時に来た場合**：同様に行ロックで直列化される。後の側の`before`は、先の側のコミット後の値になる。
- **記録（INSERT）自体の失敗**（DB障害・制約違反・サイズ超過・禁止キー検出）：例外がTx外まで伝わりTx全体がロールバックされる。業務更新も反映されない。クライアントには500 `INTERNAL_ERROR`（`{ code, message }`、内部情報なし）を返す。
- **業務更新の失敗**（409・404・その他の例外）：Txごとロールバックされ、成功ログは残らない。
- **ログインの失敗ログ**：業務更新が無い（または`failedLoginCount`の更新だけ）ので、`failedLoginCount`更新と同一Txで記録する。記録に失敗したら、ログイン失敗の応答は401ではなく500になる（fail closed。監査できない状態では認証系の操作を進めない）。DB障害時は他の操作も止まっているので影響は小さい。
- **パスワード検証（argon2）はTxの外で行う**。重い処理の間、DB接続・行ロックを保持しないため。ログイン成功時は、検証後に「`failedLoginCount`リセット＋セッション作成＋監査ログ」を1つのTxで行う（`SessionsService.createSession`・`revokeSession`は`tx`を引数で受け取れる）。
- **`occurredAt`に`clock_timestamp()`を使う理由**：`now()`はTx開始時刻で、行ロックを待った側が「開始は先だがコミットは後」になると、記録の時刻順と実際の更新順が逆転する。`clock_timestamp()`はINSERT実行時の時刻で、ロック取得後に呼ばれるため、更新の実行順と一致する。
- **デッドロック**：申請の更新系は「1つの申請行だけをロック」→「INSERT」の順で、複数行の取得順序が絡まない。ロール剥奪は既存の悲観ロック（ADMINロールの`user_roles`行・`users`行）に`audit_logs`のINSERTが加わるだけで、INSERTはロック対象と競合しない（新規行のみ）。ロール変更ではユーザー行への追加ロックを**取らない**（取ると既存のADMIN一括ロックとの取得順序が逆になりデッドロックし得る。差分記録にしたのはこの理由も含む）。
- **ログの肥大化**：ログイン失敗はIP単位のレート制限（1分10回、既存の`ThrottlerGuard`）の範囲でしか増えない。保持期間・アーカイブは当面なし（PO判断No.8。宿題）。

## エンドポイント一覧

| メソッド・パス | 必要なロール | 正常時ステータス | 異常時ステータス・エラーコード | 対応する受け入れ条件 |
| --- | --- | --- | --- | --- |
| `GET /admin/audit-logs` | `ADMIN` | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（`ADMIN`ロールなし。`MANAGER`・`ACCOUNTING`・`APPLICANT`のみのユーザーも403）／400 `VALIDATION_ERROR`（不正なクエリ・想定外のプロパティ） | 管理者だけが閲覧できる。それ以外のロールは403／一覧は`{ items, total, page, pageSize }`で返し1ページ50件／操作者（`actorUserId`・`actorEmail`）・対象・期間で絞り込める |

- **認可**：既存の`AdminUsersController`と同じく`@UseGuards(RoleGuard)`＋`@Roles(RoleName.ADMIN)`。ログイン必須（グローバルな`SessionAuthGuard`）で、`@Public()`は付けない。ロールはGuardで判定する（横断ルール1）。他人のデータを取るエンドポイントではなく「管理者が全件を見る」エンドポイントなので、Serviceでのユーザー条件は不要（本人性ではなくロールで制御する設計）。コントローラは`AdminAuditLogsController`として分け、`GET`だけを実装する。`POST`・`PUT`・`PATCH`・`DELETE`のルートは作らない（存在しないパスは404）。
- **クエリ（すべて任意）**：`AuditLogListQuery`（`packages/shared`）。DTOクラスは`@IsOptional`＋以下で検証し、`whitelist`・`forbidNonWhitelisted`により想定外の項目は400。

  | クエリ | 検証 | 意味 |
  | --- | --- | --- |
  | `page` | 整数・1〜`AUDIT_LOG_MAX_PAGE`（10000）。省略時1 | ページ番号（1始まり） |
  | `actorUserId` | UUID | 操作者（ログイン済みユーザー）で絞り込み |
  | `actorEmail` | メール形式（`@IsEmail()`）・254文字以内 | ログイン失敗時に入力されたメールアドレスの**完全一致**で絞り込み（PO判断No.4。特定のメールアドレスへの攻撃の調査用）。`actorEmail`列に対する`=`比較で、部分一致・前方一致・大文字小文字の無視はしない。ログインのメール検索（`findUnique`）も大文字小文字を区別するため揃えている |
  | `targetType` | `AuditTargetType`のいずれか | 対象の種類で絞り込み |
  | `targetId` | UUID | 対象IDで絞り込み |
  | `from` | タイムゾーンのオフセット必須のISO8601日時（例：`2026-11-01T00:00:00+09:00`、`Z`可）。オフセット無しは400 | 期間の開始（含む。`occurredAt >= from`） |
  | `to` | 同上 | 期間の終了（含まない。`occurredAt < to`）。`from`と両方ある場合は`from < to`でなければ400 |

  - 日付への変換（「11/1〜11/30」を`from=11/1 00:00+09:00`・`to=12/1 00:00+09:00`にする等）はフロントで行う（No.7）。APIは日付だけの入力を受け付けない。
  - `action`・`result`での絞り込みは追加しない（No.10）。付けると`forbidNonWhitelisted`で400。
  - `actorUserId`と`actorEmail`を同時に指定した場合は両方のAND条件（実在ユーザーのログイン失敗は`actorUserId`がnullなので、同時指定すると該当なしになり得る。想定どおりの動き）。
  - `pageSize`は受け付けない（固定50件＝`AUDIT_LOG_PAGE_SIZE`。クエリに付けると`forbidNonWhitelisted`で400）。
  - 絞り込み条件はすべて`where`にAND条件でバインドする（Prismaのパラメータ化。文字列結合しない）。
  - 件数：`findMany`（`skip = (page-1)*50`、`take = 50`、`occurredAt desc, id desc`）と`count`を、同じ`where`で実行する。
- **レスポンス**：`AuditLogListResponseDto`＝`{ items: AuditLogDto[], total, page, pageSize }`（横断ルール6）。範囲外のページは`items: []`を200で返す（`total`は実件数）。`before`/`after`もそのまま返す（ホワイトリスト済みの値だけが入っている前提）。
- **`failureCode`はレスポンスに含める**（管理者向けログなので区別して見せてよい＝No.3）。クライアント（ログイン画面）へのレスポンスは従来どおり統一の401 `AUTH_INVALID_CREDENTIALS`のまま変えない。
- **レスポンスにも機微情報を出さない**：DB列に機微情報は無いが、`AuditLogDto`への変換はホワイトリスト列を明示的に選ぶ（`select`）形にして、将来列が増えても自動で露出しないようにする。

## 補足

- 入力はDTO＋ValidationPipeで検証する。監査ログの`action`・`targetType`・`result`・`failureCode`は、サーバーが決める値（`packages/shared`の定数）だけで、クライアントから受け取らない。
- 500エラーは`INTERNAL_ERROR`で、スタックトレース・SQL・トリガーのメッセージを含めない。
- エラーコードの追加は無し（既存の`FORBIDDEN`・`VALIDATION_ERROR`・`AUTH_UNAUTHORIZED`を再利用）。
- 監査ログの操作は、承認・差し戻しをそれぞれ独立した1操作1メソッド（`approve`・`returnRequest`）として実装している既存の構成にそのまま乗せる。

## マイグレーション

`apps/api/prisma/migrations/20261125000000_add_audit_logs/migration.sql`の1つに、(1) `audit_logs`テーブルとインデックス、(2) 追記専用トリガー（手書きSQL）をまとめている。`pnpm test:e2e:api`（`migrate deploy`）で適用される。

## テスト観点（テスト担当への引き継ぎ）

- 操作ごとに、成功すると対応する`action`の監査ログが1件増え、`actorUserId`・`targetType`・`targetId`・`before`・`after`・`ipAddress`が正しい（上の一覧表）。
- **権限のないロールでは失敗する**：`ADMIN`以外（`APPLICANT`・`MANAGER`・`ACCOUNTING`のみ）の`GET /admin/audit-logs`は403、未ログインは401。
- ページネーション：51件目が2ページ目に出る／`pageSize`クエリは400／`from >= to`は400／不正なUUIDは400／範囲外ページは空の`items`。絞り込み（操作者・対象・期間、複合）。
- `actorEmail`の絞り込み：完全一致だけ該当する（部分一致・大文字小文字違いは出ない）／メール形式でない値は400／`action`・`result`クエリは400。
- 期間：オフセット無しの日時は400／`from`ちょうどの`occurredAt`は含まれ、`to`ちょうどは含まれない（半開区間）／`+09:00`と`Z`で同じ瞬間なら同じ結果。
- 記録しないこと：403・404・409（ログイン失敗以外）、429、申請の閲覧、`GET /admin/audit-logs`自体の閲覧でログが増えない。ロール付与で既に保持していた場合（応答は新規付与と同じ201。PO判断で確定）もログが増えない。
- 領収書（PBI5実装時）：ログに署名付きURL・保存パス・保存ファイル名が含まれない。
- **パスワード等が含まれない**：ログイン成功・失敗後の全ログ行のJSON全体を文字列化して、パスワード・`passwordHash`・セッショントークン・Cookie値が含まれない。
- **記録失敗で業務更新も失敗する**：`AuditLogService.record`を失敗させると、申請の作成・編集・削除・提出・承認・差し戻し・ロール付与・剥奪・ログイン・ログアウトの業務更新がロールバックされ、500が返る。
- **更新が成立しないとログが無い**：409（承認と差し戻しの同時実行の敗者、`SUBMITTED`以外の承認など）・404のとき、成功ログが増えない。同時実行で成功ログが1件だけ。
- **追記専用**：SQL直接実行の`UPDATE`・`DELETE`・`TRUNCATE`が拒否される（トリガー）。ソースに`auditLog`の更新・削除メソッド呼び出しが無い。
- ログイン失敗の4種（存在しない・パスワード違い・無効化済み・ロック中）が`failureCode`つきで記録され、クライアントへのレスポンスは従来どおり同一（`AUTH_INVALID_CREDENTIALS`）。

## 判断が必要な点（PO回答と反映結果）

初回設計で挙げた14点への、PO回答（`docs/requirements/sprint-3.md`、2026-11-25）と、このドキュメント・`packages/shared`・`schema.prisma`への反映。

| No. | 論点 | PO回答 | 反映 |
| --- | --- | --- | --- |
| 1 | 失敗の記録範囲 | ログイン失敗のみ。403の記録は宿題 | 暫定案どおり。「記録しないもの」「同時実行」「失敗ログを補う案」を確定の記述に変更 |
| 2 | ロール付与で既に保持 | 実際に作成されたときだけ記録 | 暫定案どおり。操作一覧に確定と明記 |
| 3 | ログイン失敗の理由 | 管理者向けログには区別して残してよい。クライアントへは統一401 | 暫定案どおり。`failureCode`をレスポンスに含め、クライアント応答は不変と明記 |
| 4 | 操作者の絞り込み | `actorEmail`の完全一致での絞り込みも追加 | **変更あり**。`AuditLogListQuery.actorEmail`追加（shared）、クエリ表・テスト観点に追加、`@@index([actorEmail, occurredAt])`追加（schema） |
| 5 | 閲覧の記録 | 申請の閲覧・監査ログの閲覧は記録しない。監査ログ閲覧の記録は宿題 | 暫定案どおり |
| 6 | メール欄へのパスワード混入 | メール形式の入力だけ記録するので残りのリスクは受容 | 暫定案どおり。受容を明記 |
| 7 | 期間 | ISO8601、オフセット必須の半開区間。日付変換はフロント | 暫定案どおり。オフセット無しは400と明記、フロントの責務を明記 |
| 8 | 保持期間 | 当面なし。宿題 | 暫定案どおり |
| 9 | TRUNCATE拒否 | 採用 | 暫定案どおり。トリガー設計を確定 |
| 10 | action・resultの絞り込み | 追加しない | 暫定案どおり。付けると400と明記 |
| 11 | CLAUDE.md横断ルール4 | 承認 | ルート`CLAUDE.md`を変更済み |
| 12 | 署名付きURL・保存パス・ファイル名 | 監査ログに載せない（URLは持っている人が見られる鍵のため） | 操作一覧・テスト観点に明記。PBI5設計で守る。**元のファイル名**の扱いは回答になく未解決（下記） |
| 13 | 持ち越し（差し戻し理由をtrimしない） | 満たしているので完了 | 設計変更なし。`returnReason`は入力どおり記録のまま |
| 14 | 429の記録 | 記録しない。宿題 | 暫定案どおり |

### 宿題一覧（PO判断により後回し。今回のスコープ外）

- 権限不足（403）の記録（No.1）
- 監査ログの閲覧自体の記録（No.5）
- 保持期間・アーカイブ方針（No.8）
- レート制限（429）で弾かれた試行の記録（No.14）
- メールアドレスを保存時・ログイン時に小文字にそろえる（PO判断：PBI 6テストと設計の残りへの回答）
- DBロールの分離（docker-composeの2ロール化、本番のアプリ用ロール。PO判断：PBI 6実装報告・セキュリティレビューへの回答）
- 監査専用ロールに分けるか、ログの容量（保持期間の宿題と合わせて扱う。PO判断：セキュリティレビュー 軽微-2・3）

### 追加の判断（初回の回答後）

1. **領収書の元のファイル名を監査ログに載せるか**（No.12の回答は署名付きURL・保存パス・保存ファイル名のみ）：**PBI 5の設計で決める**（PO判断）。それまでは載せない。
2. **`actorEmail`絞り込みの大文字小文字**：**今回はバイト一致のまま**（PO判断）。メールアドレスを小文字にそろえる件は宿題。
3. **No.4の副作用（周知事項）**：`actorEmail`で絞ると、存在しないメールアドレスへの試行（`targetId`＝null）も検索できる。No.6で受容したパスワード由来文字列の混入も、管理者が入力値で検索できる。
