# PBI1・PBI2 エンドポイント一覧

PBI1（ログイン・ログアウト）・PBI2（ロールと権限）で確定したAPI設計のまとめ。
実装（Controller/Service/Guard本体）はこのドキュメント作成時点では未着手。

## 全体方針（確定事項）

- セッションにはロールをキャッシュしない。リクエスト毎にDBから最新の`UserRole`を引いて権限判定する（ロールを外されたら次のリクエストから即失効する）。
- ログイン失敗回数・ロックアウト状態は`User`本体に持たせる（`failedLoginCount`, `lockedUntil`）。5回連続失敗で15分ロックするが、ロック中も含め認証失敗レスポンスは常に`401 AUTH_INVALID_CREDENTIALS`で統一し、専用のロック用エラーコード・ステータスは設けない（理由は後述の「認証失敗レスポンスの統一」を参照）。
- セッションの有効期限は「絶対8時間（`expiresAt`、ログイン時に固定）」＋「無操作30分のスライディング期限（`lastSeenAt`判定）」の両方を併用する。`lastSeenAt`の更新は1分間隔で間引く。
- パスワード違い・存在しないユーザー・無効化(`isActive=false`)されたユーザー・ロックアウト中のログイン試行は、すべて同一エラーコード（`AUTH_INVALID_CREDENTIALS`）・同一メッセージを返す（ユーザー列挙対策）。
- ロール付与・剥奪は1件ずつPOST/DELETEで行う。最後のADMINロール保持者からADMINを剥奪する操作は`FORBIDDEN_LAST_ADMIN`で拒否する（悲観ロックで排他制御）。
  - `FORBIDDEN_LAST_ADMIN`は多層防御のためのチェックであり、単発の操作では発生しない（自分自身チェックが先に評価されるため、到達するのは同時実行時の競合のみ）。管理者の人数は`isActive=true`のユーザーのみで数える。
- 管理者は自分自身のロールを変更できない（`FORBIDDEN_SELF_ROLE_CHANGE`）。本人チェックはGuardではなくService層で行う。
- `User`は物理削除しない（退職者等は`isActive=false`の論理削除のみ）。無効化実行APIは本ドキュメントのスコープ外（将来PBI）だが、無効化時は対象ユーザーの全セッションを一括失効させる設計を前提とする。
- `GET /admin/users`はページネーションを実装しないが、サーバー側で最大100件のハードリミットを設ける（クライアントに公開するパラメータではない）。

### 認証失敗レスポンスの統一（ロックアウト中も401 AUTH_INVALID_CREDENTIALS）

ロック中のアカウントだけ別のステータス・エラーコード（423, 429, `AUTH_LOCKED`等）を返すと、攻撃者が「5回間違えたらロックされた＝このメールアドレスは登録されている」と判別できてしまう（存在しないメールアドレスはロックされないため）。そのため、メール/パスワード誤り・存在しないユーザー・無効化済みユーザー・ロックアウト中のいずれであっても、常に`401 AUTH_INVALID_CREDENTIALS`・同一メッセージを返す。

エラーメッセージ文言例：「メールアドレスまたはパスワードが違います。何度も失敗した場合は、しばらく時間をおいてください。」（本人がロックアウトに気づけるよう促しつつ、ロック中であることを確定的には伝えない表現）

### タイミング攻撃対策

存在しないユーザーのログイン試行では、argon2によるパスワード検証をスキップするとレスポンスが速くなり、これもユーザー列挙の手がかりになる。対策として、存在しないユーザーでログインが試行された場合も、ダミーのargon2ハッシュに対して検証処理を1回実行し、レスポンス時間を存在するユーザーの場合と揃える（実装はSprintの実装フェーズで対応。方針のみここに記載）。

### CSRF対策

- SPA（`apps/web`）とAPI（`apps/api`）が同一サイトである前提のもと、Cookieは`SameSite=Lax`に加え、状態を変更するリクエスト（POST/PUT/PATCH/DELETE）では`Origin`ヘッダーを検証し、許可したオリジン以外からのリクエストは`403 FORBIDDEN`で拒否する。
- `POST /auth/login`もこのチェックの対象に含める（未ログイン状態のエンドポイントであっても、ログインCSRF攻撃を防ぐため例外にしない）。

### ユーザー作成・上長(managerId)設定のスコープ

ユーザー新規作成・`managerId`設定・`isActive`無効化を実行するAPIは本PBI（PBI1/PBI2）のスコープ外。「Userが上長（managerId）を持てる」はテーブル構造として持てればよく、Sprint1ではシードデータでユーザーと上長関係を投入する想定。ユーザー作成・managerId設定・無効化実行は、別PBI「ユーザー管理」（Should優先度）として別途切り出して対応する。

### シード方針

- ロールマスタ`Role`に4種（`APPLICANT`, `MANAGER`, `ACCOUNTING`, `ADMIN`）を投入する。
- 初期管理者ユーザー（`ADMIN`ロール付き）を1件シードで投入する。初期管理者のパスワードは環境変数（例: `SEED_ADMIN_PASSWORD`）から読み込み、リポジトリにハードコードしない。
- 上記に加え、テスト担当がテストデータ（上長関係を含む複数ユーザーのパターン等）を作りやすいように、シードスクリプトは拡張しやすい構造にしておくことが望ましい。

## エンドポイント一覧

| メソッド・パス | 必要なロール | 正常時ステータス | 異常時ステータス・エラーコード | 対応する受け入れ条件・決定事項 |
| --- | --- | --- | --- | --- |
| `POST /auth/login` | 不要（`@Public`） | 200 | 401 `AUTH_INVALID_CREDENTIALS`（メール/パスワード誤り・存在しないユーザー・無効化済みユーザー・ロックアウト中、すべて同一）／400 `VALIDATION_ERROR`（入力不正）／403 `FORBIDDEN`（許可されていないOriginからのリクエスト。CSRF対策。未ログインの公開APIでも対象） | PBI1: 正しい認証でCookie発行／パスワード違いと存在しないユーザーで同一エラー／5回失敗で15分ロック／成功時セッションID再発行 |
| `POST /auth/logout` | ログインのみ | 204 | 401 `AUTH_UNAUTHORIZED`（未ログイン・セッション失効）／403 `FORBIDDEN`（許可されていないOriginからのリクエスト。CSRF対策） | PBI1: ログアウトでサーバー側セッション削除、以後同じCookieで401 |
| `GET /auth/me` | ログインのみ | 200 | 401 `AUTH_UNAUTHORIZED`（未ログイン・セッション失効） | PBI1: 未ログインで保護APIを呼ぶと401／PBI2: フロントが自分のロール一覧を知るために必要 |
| `POST /admin/users/:userId/roles` | ADMIN | 201 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（ADMINロールなし、または許可されていないOriginからのリクエスト。CSRF対策）／403 `FORBIDDEN_SELF_ROLE_CHANGE`（対象が自分自身）／404 `NOT_FOUND`（対象ユーザー・ロールが存在しない）／400 `VALIDATION_ERROR` | PBI2: ロール付与は管理者専用／自分自身のロールは変更不可／管理者専用APIを他ロールで呼ぶと403 |
| `DELETE /admin/users/:userId/roles/:roleId` | ADMIN | 204 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（ADMINロールなし、または許可されていないOriginからのリクエスト。CSRF対策）／403 `FORBIDDEN_SELF_ROLE_CHANGE`（対象が自分自身）／403 `FORBIDDEN_LAST_ADMIN`（最後のADMIN剥奪）／404 `NOT_FOUND`（対象ユーザー・ロール・付与関係が存在しない） | PBI2: ロール剥奪は管理者専用／自分自身のロールは変更不可／最後の管理者からADMINを外せない／ロールを外されたら即失効（セッション非キャッシュ方針） |
| `GET /admin/users/:userId/roles` | ADMIN | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（ADMINロールなし）／404 `NOT_FOUND`（対象ユーザーが存在しない） | PBI2: 管理者がロール付与前に現状確認するために必要 |
| `GET /admin/roles` | ADMIN | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（ADMINロールなし） | PBI2: 付与可能なロールの選択肢を取得するために必要 |
| `GET /admin/users` | ADMIN | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（ADMINロールなし） | PBI2: 権限設定画面で全ユーザー一覧が必要（ページネーションなし、サーバー側で最大100件のハードリミット） |

## 補足

- すべてのエンドポイントで、入力はDTO＋ValidationPipe（`whitelist`, `forbidNonWhitelisted`）により検証し、想定外のプロパティは拒否する。
- 500エラー（`INTERNAL_ERROR`）はスタックトレースやSQLなどの内部情報を含めず、`{ code, message }`の統一形式で返す。
- 他人のリソースに対する不正な参照は404を返す方針だが、本ドキュメントのロール管理APIは「管理者が任意ユーザーを操作する」業務が正規フローのため、対象ユーザー不存在は404、権限不足（ADMINロールなし）は403という区別を採用する。
- ロール変更（付与・剥奪）は監査ログの対象（PBI 6で実装済み。詳細は`docs/api/pbi-6.md`）。`RolesService`は`AuditLogService`を必須依存として受け取り、付与・剥奪と同一トランザクションで`ROLE_GRANT`／`ROLE_REVOKE`を記録する。すでに保持しているロールの再付与は応答が新規付与と同じ201で、ログは記録しない。`RoleChangeAuditPayload`型はPBI 6で削除済み。

## マイグレーション

`apps/api/prisma/migrations/20261121095403_init_user_role_session/` を`prisma migrate dev`で生成済み、ローカルDBにも反映済み。本マイグレーションファイルはコミット対象（手動編集はしない）。
