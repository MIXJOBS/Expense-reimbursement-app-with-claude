# PBI4 エンドポイント一覧

PBI4（承認・差し戻し）で確定したAPI設計のまとめ。
実装（Controller/Service/Guard本体）はこのドキュメント作成時点では未着手（設計のみ）。
フォーマットは`docs/api/pbi-3.md`に合わせる。

## 全体方針（確定事項）

- 承認・差し戻しの対象は、PBI3で作成された`ExpenseRequest`のうち`status = SUBMITTED`（申請中）のものだけ。承認すると`APPROVED`（承認済み）、差し戻すと`RETURNED`（差し戻し）になる。
- **承認者の決め方（`approverId`）**：提出時（`POST /expenses/:id/submit`、既存PBI3のエンドポイント）に、申請者の`User.managerId`をその時点の値として`ExpenseRequest.approverId`に保存する。差し戻し後の再提出でも同じ`submit`エンドポイントが使われるため、その時点の`managerId`で自然に上書きされる（再提出時専用の分岐は設けない）。詳細は「提出エンドポイント（PBI3）の挙動変更」を参照。
- **リソースの分離**：申請者向けエンドポイントは`/expenses`、承認者向けエンドポイントは`/approvals`という**別リソース**に分ける（`/expenses/approvals`のようなネストはしない）。理由はルーティング上の安全性と権限管理のしやすさの両方：`GET /expenses/:id`（`:id`はUUID想定）と同じ階層に`approvals`という固定文字列パスを混在させると、NestJSのルーティング優先順位次第で`approvals`が`:id`パラメータとして誤って解釈され、UUID形式でないため意図しない`400`になるリスクがある。加えて、申請者が使うのが`/expenses`・承認者が使うのが`/approvals`とURLレベルで分かれることで、「誰のための画面か」が明確になり権限の管理もしやすくなる。
- **承認・差し戻しできる人の判定は2段階**（CLAUDE.mdの横断ルール1「ロールはGuard、本人かどうかはServiceで判定する」に従う）。
  1. **ロール**（Guard）：`RoleName.MANAGER`を持たないユーザーが承認者向けエンドポイント（`/approvals`系・`/approvals/:id/approve`・`/approvals/:id/return`）にアクセスした場合、既存の`RoleGuard`＋`@Roles(RoleName.MANAGER)`で`403 FORBIDDEN`を返す（`apps/api/src/admin/role.guard.ts`と同じ仕組みを再利用する）。
  2. **承認者本人かどうか**（Service）：`MANAGER`ロールを持っていても、対象の申請の`approverId`が自分のユーザーIDと一致しなければ`404 NOT_FOUND`（他人の申請として扱う。PBI3の「他人の申請は404」方針と同じ）。
  - **職務分離（CLAUDE.md大前提）**：申請者本人は、ロールに関係なく自分の申請を承認・差し戻しできない。`managerId`が自分自身を指す等の異常データがあっても確実に弾くため、Serviceの検索条件に`applicantId: { not: 自分のユーザーID }`を明示的に含める（`approverId`の一致だけに依拠しない防御的な実装方針）。
- 一覧・閲覧（承認者視点）は、`approverId = 自分`かつ`status = SUBMITTED`の申請だけに絞る（受け入れ条件：「直属の部下の『申請中』の申請だけを一覧・閲覧できる。それ以外は404」）。一覧は`findMany`の`where`に、閲覧（詳細）は`findFirst`の`where`に、同じ絞り込み条件（`approverId`・`status`・`applicantId not self`）を含める。
- 承認・差し戻しの状態変更は、PBI3の`update`/`remove`/`submit`と同じ「条件付き`updateMany`」方式。`where`に`status: { in: EXPENSE_APPROVABLE_STATUSES }`（または`EXPENSE_RETURNABLE_STATUSES`。いずれも`[SUBMITTED]`のみ）を含め、影響行数が0件なら`409 CONFLICT_INVALID_STATUS`（既存コードを再利用）。これにより「承認と差し戻しが同時に来ても、成功するのは片方だけ」が自然に実現される（先に成功した側がステータスを`SUBMITTED`から変えるため、後から来た側の`updateMany`は対象0件になる）。
- 差し戻し時のリクエストボディに理由（必須・500文字まで、`EXPENSE_RETURN_REASON_MAX_LENGTH`）を持たせ、`ExpenseRequest.returnReason`に保存する。承認時にはリクエストボディ自体を設けない（送るべき項目がないため）。
- 差し戻された申請は、申請者が編集して再提出できる（PBI3で実装済みの`PUT /expenses/:id`・`POST /expenses/:id/submit`がそのまま使える。`EXPENSE_EDITABLE_STATUSES`・`EXPENSE_SUBMITTABLE_STATUSES`に既に`RETURNED`が含まれているため、PBI3側の変更は不要）。
- **生SQL（`$executeRaw`／`$queryRaw`）を使う際の必須ルール**：値を埋め込む際は必ず`Prisma.sql`のタグ付きテンプレートリテラル経由で渡すこと。テンプレート文字列での直接埋め込みや`+`による文字列結合で値を埋め込むことは絶対にしない（SQLインジェクション対策。詳細は「提出エンドポイント（PBI3）の挙動変更」および「判断に迷ったところ」参照）。

## エンドポイント一覧

| メソッド・パス | 必要なロール | 正常時ステータス | 異常時ステータス・エラーコード | 対応する受け入れ条件 |
| --- | --- | --- | --- | --- |
| `GET /approvals` | `MANAGER` | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（`MANAGER`ロールなし） | 承認者は、直属の部下の「申請中」の申請だけを一覧できる |
| `GET /approvals/:id` | `MANAGER` | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（`MANAGER`ロールなし）／404 `NOT_FOUND`（存在しない・自分が承認者でない・自分自身の申請・`SUBMITTED`以外） | 承認者は、直属の部下の「申請中」の申請だけを閲覧できる。それ以外は404 |
| `POST /approvals/:id/approve` | `MANAGER` | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（CSRF対策。または`MANAGER`ロールなし）／404 `NOT_FOUND`（存在しない・自分が承認者でない・自分自身の申請）／409 `CONFLICT_INVALID_STATUS`（`EXPENSE_APPROVABLE_STATUSES`=`SUBMITTED`以外。差し戻しと同時実行で片方が先に成立した場合を含む） | 承認すると「承認済み」になる／申請者本人は自分の申請を承認できない／「申請中」以外を承認すると409／承認と差し戻しの同時実行は片方のみ成功 |
| `POST /approvals/:id/return` | `MANAGER` | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（CSRF対策。または`MANAGER`ロールなし）／404 `NOT_FOUND`（存在しない・自分が承認者でない・自分自身の申請）／400 `VALIDATION_ERROR`（`reason`未指定・501文字以上・想定外プロパティ）／409 `CONFLICT_INVALID_STATUS`（`EXPENSE_RETURNABLE_STATUSES`=`SUBMITTED`以外。承認と同時実行で片方が先に成立した場合を含む） | 差し戻すと「差し戻し」になる／差し戻しには理由（500文字まで）が必須／申請者本人は自分の申請を差し戻せない／「申請中」以外を差し戻すと409／承認と差し戻しの同時実行は片方のみ成功 |

### 提出エンドポイント（PBI3）の挙動変更

`POST /expenses/:id/submit`（`docs/api/pbi-3.md`で設計済み・実装済み）自体のURL・ロール・レスポンス形式は変更しない。ただし、`SUBMITTED`への遷移時の内部動作を以下のように変更する必要がある（**今回は設計のみで、`apps/api/src/expenses/expenses.service.ts`の実装は変更しない**）。

- **現状（PBI3実装）**：`submit`は「ステータス確認→上長(`managerId`)確認（別SELECT）→条件付き`updateMany`（`status`のみ更新）」という2段階方式。上長確認のSELECTと実際のUPDATEが分離しているため、理論上その間に`managerId`が変わる余地がある（直前のセキュリティレビュー指摘）。
- **変更後**：「ステータスがDRAFT/RETURNEDであること」の確認に加えて、「申請者のmanagerIdがNULLではないこと」と「承認者IDの代入」を**同一UPDATE文の中で1回で行う**。Prismaの標準API（`updateMany`の`data`）では他テーブル（`User`）の現在値を参照して書き込む相関更新ができないため、PostgreSQLの`UPDATE ... FROM ... WHERE ...`形式の生SQL（`$executeRaw`。`apps/api/src/admin/roles.service.ts`の`$queryRaw`パターンと同様にPrisma.sqlを使う）を利用する。

  **生SQLを書く際の必須ルール（実装時に厳守すること）**：`$executeRaw`に値を渡す際は、必ず`Prisma.sql`のタグ付きテンプレートリテラル（またはPrismaが提供するパラメータ化APIである`$executeRaw`のテンプレートリテラル構文）経由で渡すこと。テンプレート文字列での直接埋め込み（例：`` `... = '${id}'` ``）や`+`による文字列結合で値をSQL文に埋め込むことは**絶対にしない**。これはSQLインジェクションを防ぐための必須ルールであり、本PBIで生SQLを書く箇所（本セクションの`submit`のUPDATE文）に例外なく適用する。

  イメージ：

  ```sql
  UPDATE expense_requests er
  SET status = 'SUBMITTED', approver_id = u."managerId", "updatedAt" = now()
  FROM users u
  WHERE u.id = er."applicantId"
    AND er.id = :id
    AND er."applicantId" = :applicantId
    AND er.status IN ('DRAFT', 'RETURNED')
    AND u."managerId" IS NOT NULL
    AND u."managerId" != u.id
  ```

  （`:id`・`:applicantId`は実装時に`Prisma.sql`のテンプレートリテラルでバインドするパラメータを表すプレースホルダであり、文字列結合で埋め込む値ではない。）

  - **自己参照チェック（`u."managerId" != u.id`）の追加**：申請者の`managerId`が申請者自身を指している（上長が自分自身という自己参照データ）場合、そもそも`approverId`としてそのIDを保存しない。これにより、提出の時点で自己参照データを検知してブロックするのが1段目の防御、承認・差し戻し時にServiceの`where`で`applicantId: { not: 自分 }`を明示的に除外するのが2段目の防御となる（二重の守り）。
  - この単一UPDATEの影響行数が0件のとき、「ステータス不正（409 `CONFLICT_INVALID_STATUS`）」と「上長未設定（409 `CONFLICT_MANAGER_NOT_SET`）」のどちらを報告すべきかを区別する必要がある。PBI3と同じ2段階方式（事前の読み取り専用チェックでどちらの409かを決め、実際の状態変更は上記の単一UPDATEの結果を最終的な正とする）を維持する。事前チェックと実更新の間に競合が生じても、実更新のWHERE条件（ステータス・申請者ID・上長NOT NULL・上長が自分自身でないことを全て含む）がデータ整合性を保証するため安全。
  - **`managerId`が自分自身を指すユーザーが提出しようとした場合の扱い**：`managerId IS NOT NULL`ではあるが自己参照（`managerId = 自分のid`）であるため、上記UPDATEは0件になる。これは意味合いとしては「上長が実質的に未設定（使える上長がいない）」に近いため、新しいエラーコードは設けず、既存の`409 CONFLICT_MANAGER_NOT_SET`として扱う。事前の読み取り専用チェック（上長未設定かどうかの判定）も、`managerId IS NULL`に加えて`managerId = 自分のid`の場合を同じく「上長未設定」として判定する必要がある。
  - 差し戻し(`RETURNED`)から再提出したときも同じSQLが走るため、その時点の`managerId`で`approverId`が自然に上書きされる（特別な分岐は不要）。

## 補足

- すべてのエンドポイントで、入力はDTO＋ValidationPipe（`whitelist`, `forbidNonWhitelisted`）により検証する。`POST /approvals/:id/return`は`reason`以外のプロパティ（`status`等）を送ると`400 VALIDATION_ERROR`になる。
- 500エラー（`INTERNAL_ERROR`）はスタックトレースやSQLなどの内部情報を含めず、`{ code, message }`の統一形式で返す。
- `GET /approvals`・`GET /approvals/:id`・`POST /approvals/:id/approve`・`POST /approvals/:id/return`はいずれもPrismaの`where`に`approverId: 自分のユーザーID`・`applicantId: { not: 自分のユーザーID }`を含める設計にする（「他人の承認対象が見えてから404で弾く」のではなく「そもそも検索結果・更新対象に現れない」形にする。PBI3の「他人の申請は404」の考え方と同じ）。
- `applicantId: { not: 自分のユーザーID }`は、通常の運用では`approverId`（＝`managerId`）が自分自身を指すことはない前提だが、CLAUDE.mdの「自分の申請への承認・経理確認は、ロールに関係なく申請者本人かどうかで弾く（職務分離）」を**データ不整合時にも**確実に満たすための防御的な条件として、Serviceの`where`に明示する。
- 承認（`approve`）・差し戻し（`return`）は、PBI3の`update`/`remove`/`submit`と同じ「2段階方式」を踏襲する：
  1. `approverId`・`applicantId not self`のみの条件で存在確認 → 無ければ404。
  2. `status: { in: EXPENSE_APPROVABLE_STATUSES（またはEXPENSE_RETURNABLE_STATUSES）}`も条件に加えた条件付き`updateMany`を実行。件数が0件なら409 `CONFLICT_INVALID_STATUS`。
  - `return`の`updateMany`の`data`には`status: RETURNED`と`returnReason`を同時にセットする（単一のUPDATE文で完結させる。理由の保存だけ別クエリにすると、ステータスだけ変わって理由が保存されない中間状態が生まれ得るため）。
- 一覧・閲覧（承認者視点）のレスポンス型は、申請者視点（`GET /expenses`・`GET /expenses/:id`）と同じ`ExpenseRequestDto`を使う（`packages/shared/src/expenses.ts`）。権限の違いはURL・Service層の`where`条件で制御し、レスポンスの形自体は分けない。
- 監査ログ（誰が・いつ・何に・何をしたか）の記録自体はSprint3（PBI6）のスコープ。本PBIでも、承認・差し戻しをそれぞれ独立した1操作1メソッド（`approve`・`return`）として実装する方針とする（PBI3と同じ指針）。

## マイグレーション

今回は**マイグレーションファイルを生成しない**（`prisma/schema.prisma`の変更のみ）。理由はPBI3と同じ：本PBIは「設計のみ」のタスクであり、Controller/Service等の実装が存在しない状態でマイグレーションを先行生成すると、実装フェーズでのスキーマ微調整が発生した場合に意図のわかりにくい履歴になりやすいため。実装フェーズ着手時に`prisma migrate dev`を実行し、1つのマイグレーションファイルとして生成・コミットする。

## 判断に迷ったところ（実装フェーズ・PO・レビュワーへの確認事項）

1. **承認者視点のエンドポイントのURL設計（POレビューで修正）**：当初は`GET /expenses`・`GET /expenses/:id`という申請者視点の既存パスと衝突しないよう、`/expenses/approvals`というサブリソース名を採用していたが、`GET /expenses/:id`（`:id`はUUID想定）と同じNestJSルーティング階層に`approvals`という固定文字列パスが混在するため、ルーティングの優先順位次第で`approvals`が`:id`パラメータとして誤って解釈され、UUID形式でないため`400`になるリスクがあるというPOレビュー指摘を受け、承認者向けエンドポイントを**`/approvals`という別リソースに分離**する設計に変更した（`GET /approvals`・`GET /approvals/:id`・`POST /approvals/:id/approve`・`POST /approvals/:id/return`）。申請者が使うのが`/expenses`・承認者が使うのが`/approvals`とURLレベルで分かれることで、「誰のための画面か」が明確になり権限の管理もしやすくなる。操作名のパス（`/:id/approve`・`/:id/return`）は対象リソースのパスに操作名を付ける形を維持する（PBI3の`POST /expenses/:id/submit`と同じ命名パターン）。将来、経理確認（PBI5）が入る場合も`POST /expenses/:id/confirm`のような同じパターンを想定している。
2. **ロール不足時のステータスコード（403 FORBIDDEN）と、承認者本人でない場合のステータスコード（404 NOT_FOUND）の使い分け**：CLAUDE.mdの横断ルール1「ロールはGuard、本人かどうかはServiceで判定する」を素直に適用すると、`MANAGER`ロールを持たない人は403、`MANAGER`を持つが担当外（または自分自身の申請）の人は404、という2段構えになる。これはPBI1/2の既存`RoleGuard`の使い方（例：`ADMIN`ロールがないと`/admin/*`は403）と一貫するが、「ロールを持っているかどうかで403/404が変わる」ことが情報漏洩（MANAGERロールの有無が分かる）にならないか迷った。結論としては、`MANAGER`ロールの有無自体は機密情報ではなく（人事上誰が上長かは社内で公知）、CLAUDE.mdの横断ルールにも明確に反するため、素直にGuardで403・Serviceで404とする方針にした。レビューで異議があれば要相談。
3. **`approverId`設定の生SQL化**：PO指示の通り、Prismaの標準APIでは「他テーブル（User）の現在値を参照して書き込む」相関更新ができないため、`$executeRaw`（`Prisma.sql`）を使う設計とした。`apps/api/src/admin/roles.service.ts`の悲観ロック用`$queryRaw`と同様、生SQLを使う箇所はコメントで「なぜPrismaの標準APIで表現できないか」を明記する方針にする。実装フェーズでは、SQLインジェクション対策として必ず`Prisma.sql`のテンプレートリテラル経由でパラメータを埋め込み、文字列結合はしないこと。
4. **承認日時・承認者の履歴等、受け入れ条件に無いカラムの扱い**：PO指示により、今回は追加しない（`approverId`・`returnReason`のみ追加）。`approvedAt`（承認日時）・`returnedAt`（差し戻し日時）等は、受け入れ条件に「いつ承認されたか」を画面に出す要件が明記されていないため見送った。ただし`updatedAt`（既存カラム）が承認・差し戻しが起きた時刻を実質的に表すため、最低限の時系列情報は失われない。将来「承認日時を一覧に出したい」等の要件が出た場合はカラム追加で対応する。
5. **`returnReason`を再提出・承認時にクリアするか**：差し戻し理由は「次に差し戻されるまで直前の値が残る」設計にした（再提出・承認時に明示的にnullへクリアする処理は設けない）。受け入れ条件に「理由を消す」要件がなく、「直前に差し戻された理由が何だったか」を履歴的に参照できた方が監査上望ましいと判断したため。ただし、承認済み(`APPROVED`)の申請に古い`returnReason`が残り続けることが画面表示上誤解を招く場合（例：承認済みなのに差し戻し理由が表示される）、フロント（`apps/web`）側で`status`に応じて非表示にする対応が必要になる可能性がある。
6. **`ExpenseRequest.approver`リレーションの`onDelete`**：`applicant`と同じ`Restrict`にした（Userはハードデリートしない方針のため実運用では発火しないが、万一の削除経路でも承認待ちの申請を連鎖削除しないため）。`managerId`（User自己参照）が`SetNull`であることとは意図的に非対称にしている：`managerId`は「現在の上長が誰か」という設定値なのでNULL化してよいが、`approverId`は「提出時点でのスナップショット」であり、後から上長が変わっても過去の申請の承認責任の記録を保持する必要があると考えたため。
