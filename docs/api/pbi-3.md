# PBI3 エンドポイント一覧

PBI3（経費申請の登録・編集）で確定したAPI設計のまとめ。
実装（Controller/Service/Guard本体）はこのドキュメント作成時点では未着手。

## 全体方針（確定事項）

- 経費申請（`ExpenseRequest`）は `DRAFT`（下書き）で作成され、専用の提出API（`POST /expenses/:id/submit`）を叩いた時だけサーバーが `SUBMITTED`（申請中）に変更する。`status`・`applicantId`はリクエストボディのDTOに項目を設けず、ValidationPipeの`forbidNonWhitelisted`により想定外の項目として`400 VALIDATION_ERROR`で拒否する（受け入れ条件：「ステータスや申請者IDをリクエストで送ると400」）。
- 申請者IDはDTOで受け取らず、必ずログイン中のユーザー（セッション）から取得する。
- **他人の申請は常に404**を返す（403ではなく404）。本人以外には「存在しない」ことにする方針は、CLAUDE.mdの「他人の申請には404を返す」、および`docs/api/pbi-1-2.md`の「他人のリソースへの不正な参照は404」方針と同じ。本人チェックはGuardではなくService層で行う（CLAUDE.mdの横断ルール：ロールはGuard、本人かどうかはServiceで判定）。
- 一覧取得（`GET /expenses`）は、Prismaの`findMany`の`where`に必ず`applicantId: 自分のユーザーID`の条件を含める設計にする（他ユーザーの申請を一切返さない。クエリパラメータで`applicantId`を指定させる仕組みは設けない）。
- 一覧のページネーションは1ページ20件固定（`EXPENSE_LIST_PAGE_SIZE`）。クライアントが`pageSize`を自由に指定できる作りにはしない（大量取得によるDoS・他人データの総当たり探索を避けるため、`GET /admin/users`のハードリミット方針と同様の考え方）。
- 金額は1円〜1,000,000円の整数（`EXPENSE_AMOUNT_MIN`/`EXPENSE_AMOUNT_MAX`）。小数・0以下・上限超えは`400 VALIDATION_ERROR`。
- 科目（`category`）は「交通費(`TRANSPORTATION`)・交際費(`ENTERTAINMENT`)・消耗品費(`SUPPLIES`)・その他(`OTHER`)」の4値のみ許可。内容（`description`）は200文字まで。**実装時必須要件**：DTOでは`category`が文字列型であることに加え、`ALL_EXPENSE_CATEGORIES`に含まれる値であることを必ず照合する（`@IsIn(ALL_EXPENSE_CATEGORIES)`等）。型チェックのみでは未定義の文字列がそのままDBの`category`カラム（String型）に保存されてしまうため。
- 編集・削除・提出がそれぞれ許可されるステータスは、操作ごとに別々のポジティブリスト（許可されているステータスの一覧）として管理する（`EXPENSE_EDITABLE_STATUSES`／`EXPENSE_DELETABLE_STATUSES`／`EXPENSE_SUBMITTABLE_STATUSES`）。
  - **編集**（`PUT /expenses/:id`）：`DRAFT`・`RETURNED`（差し戻しは申請者が直して再提出できる。PBI4の受け入れ条件「差し戻された申請は、申請者が編集して再提出できる」を見据えた設計）
  - **削除**（`DELETE /expenses/:id`）：`DRAFT`のみ。一度でも提出した申請（差し戻し中の`RETURNED`を含む）は、上長とのやりとりの記録を残すため削除不可とする。`RETURNED`での削除は`409 CONFLICT_INVALID_STATUS`で拒否する。
  - **提出**（`POST /expenses/:id/submit`）：`DRAFT`・`RETURNED`（新規提出・差し戻し後の再提出の両方を許可）
  - 上記以外のステータスからの編集・削除・提出は、いずれも`409 CONFLICT_INVALID_STATUS`で拒否する。
- 提出時、対象ユーザーに上長（`User.managerId`）が設定されていない場合は`409 CONFLICT_MANAGER_NOT_SET`で拒否する。
- 状態と噛み合わない操作（許可リストに含まれないステータスでの編集・削除・提出）は`409 CONFLICT_INVALID_STATUS`で拒否する。

## エンドポイント一覧

| メソッド・パス | 必要なロール | 正常時ステータス | 異常時ステータス・エラーコード | 対応する受け入れ条件 |
| --- | --- | --- | --- | --- |
| `POST /expenses` | ログインのみ（`APPLICANT`は全員が持つ基本ロール） | 201 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（許可されていないOriginからのリクエスト。CSRF対策）／400 `VALIDATION_ERROR`（金額が範囲外・科目が不正・内容が201文字以上・`status`や`applicantId`等の想定外プロパティを含む等） | 下書きの作成。項目は利用日・金額・科目・内容／金額・科目・内容の入力検証／ステータス・申請者IDはサーバーが決める |
| `GET /expenses` | ログインのみ | 200 | 401 `AUTH_UNAUTHORIZED`／400 `VALIDATION_ERROR`（`page`が1未満・整数でない等） | 一覧には自分の申請だけが出る／1ページ20件のページネーション |
| `GET /expenses/:id` | ログインのみ | 200 | 401 `AUTH_UNAUTHORIZED`／404 `NOT_FOUND`（存在しない、または他人の申請） | 他人の申請をID指定で取得しようとすると404 |
| `PUT /expenses/:id` | ログインのみ | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（CSRF対策）／404 `NOT_FOUND`（存在しない、または他人の申請）／400 `VALIDATION_ERROR`（入力不正・想定外プロパティ）／409 `CONFLICT_INVALID_STATUS`（`EXPENSE_EDITABLE_STATUSES`=`DRAFT`・`RETURNED`以外、つまり`SUBMITTED`・`APPROVED`・`ACCOUNTING_CONFIRMED`の申請を編集しようとした） | 下書き・差し戻し中の申請を編集できる／入力検証／他人の申請の編集は404／申請中以降の編集は409 |
| `DELETE /expenses/:id` | ログインのみ | 204 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（CSRF対策）／404 `NOT_FOUND`（存在しない、または他人の申請）／409 `CONFLICT_INVALID_STATUS`（`EXPENSE_DELETABLE_STATUSES`=`DRAFT`以外、つまり`SUBMITTED`・`RETURNED`・`APPROVED`・`ACCOUNTING_CONFIRMED`の申請を削除しようとした） | 下書きを削除できる／他人の申請の削除は404／下書き以外（差し戻し中を含む）の削除は409 |
| `POST /expenses/:id/submit` | ログインのみ | 200 | 401 `AUTH_UNAUTHORIZED`／403 `FORBIDDEN`（CSRF対策）／404 `NOT_FOUND`（存在しない、または他人の申請）／409 `CONFLICT_INVALID_STATUS`（`EXPENSE_SUBMITTABLE_STATUSES`=`DRAFT`・`RETURNED`以外の申請を提出しようとした。例：既に`SUBMITTED`済みの二重提出）／409 `CONFLICT_MANAGER_NOT_SET`（提出者に上長が未設定） | 下書き・差し戻し中の申請を提出すると申請中になる（再提出を含む）／他人の申請の提出は404／上長未設定は409 |

### `GET /expenses` のページネーション仕様

- クエリパラメータ：`page`（任意。1始まりの整数。未指定時は`1`）。
  - `page=0`、`page=-1`（1未満の整数）、`page=abc`（数値でない）は、いずれも`400 VALIDATION_ERROR`になる。
  - 実装時、apps/api側のDTOクラスでclass-validatorにより「1以上の整数であること」を検証する（例：`@Type(() => Number) @IsInt() @Min(1)`）。
- 1ページの件数はサーバー側で`20`件固定（`pageSize`をクライアントが指定するパラメータは設けない）。
- レスポンス形式：

```jsonc
{
  "items": [
    {
      "id": "uuid",
      "applicantId": "uuid",
      "expenseDate": "2026-11-20",
      "amount": 1500,
      "category": "TRANSPORTATION",
      "description": "取引先訪問の電車代",
      "status": "DRAFT",
      "createdAt": "2026-11-20T01:23:45.000Z",
      "updatedAt": "2026-11-20T01:23:45.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

- `total`は「自分の申請」の総件数（他人の申請を含まない）。`items`が空でも200を返す（該当ページに結果がない場合も404ではなく空配列）。

## 補足

- すべてのエンドポイントで、入力はDTO＋ValidationPipe（`whitelist`, `forbidNonWhitelisted`）により検証し、`status`・`applicantId`を含む想定外のプロパティは`400 VALIDATION_ERROR`で拒否する。
- 500エラー（`INTERNAL_ERROR`）はスタックトレースやSQLなどの内部情報を含めず、`{ code, message }`の統一形式で返す。
- 他人の申請への参照・操作（取得・編集・削除・提出）はすべて404を返す（PBI1/2の「管理者が任意ユーザーを操作する」ケースとは異なり、PBI3には「他人の申請を正規に操作する業務」が存在しないため、403ではなく一律404とする）。本人判定はPrismaの`where`に`applicantId`条件を含めることで、「他人のレコードが見えてから403で弾く」のではなく「そもそも検索結果に現れない」形にする（存在確認のタイミング攻撃・情報漏洩を避ける）。
- `POST /expenses/:id/submit`の409の2種類（`CONFLICT_INVALID_STATUS`と`CONFLICT_MANAGER_NOT_SET`）は、Service層で「ステータスが`EXPENSE_SUBMITTABLE_STATUSES`（`DRAFT`・`RETURNED`）に含まれること」のチェックを先に行い、次に「上長が設定されていること」を判定する順序を想定する（どちらも成り立たない場合は最初に引っかかった方のコードを返す。両方満たさない具体例は実装時のテストで固定する）。
- 監査ログ（誰が・いつ・何に・何をしたか）の記録自体はSprint3（PBI6）のスコープ。本PBIでは経費申請の作成・編集・削除・提出が将来Interceptorで記録できるよう、Service層のメソッド単位を「1操作1メソッド」に保つ設計方針とする（実装時の指針。今回のドキュメントでは型は定義しない）。

## マイグレーション

今回は**マイグレーションファイルを生成しない**（`prisma/schema.prisma`の変更のみ）。理由：
- 本PBIは「設計のみ」のタスクであり、Controller/Service等の実装が存在しない状態でマイグレーションを先行生成すると、実装フェーズでのスキーマ微調整（カラムの型・制約の見直し等）が発生した場合に、マイグレーション履行済みファイルの修正（手動編集はしない方針）ではなく追加マイグレーションが必要になり、意図のわかりにくい履歴になりやすい。
- 実装フェーズ着手時に、スキーマの最終確認を行った上で`prisma migrate dev`を実行し、そのタイミングで1つのマイグレーションファイルとして生成するのが望ましい（`docs/api/pbi-1-2.md`の`20261121095403_init_user_role_session`と同様、実装着手時に生成してコミットする運用に揃える）。

## 判断に迷ったところ（実装フェーズ・PO・レビュワーへの確認事項）

1. **`expenseDate`の型**：`DateTime @db.Date`（時刻を持たないPostgreSQLの`date`型）とした。「利用日」は日付のみの概念で時刻やタイムゾーンを持たせる必要がないと判断したが、フロント（`apps/web`）側で日付の扱い（JSTでの境界値等）に特殊な要件がある場合は調整が必要になる可能性がある。
2. **`category`のカラム型**：Prismaのネイティブ`enum`型ではなく`String`を採用した。既存の`Role.name`と同じ方針（選択肢が増える場合にDBのenum型変更（`ALTER TYPE`）よりアプリ側の定数追加の方が小さい変更で済むため）に揃えたが、enumにすることでDB制約として不正値を防げる利点もあるため、レビューで指摘があれば変更可能。
3. **ページネーションのパラメータ名**：`page`（1始まり）のみを公開し、`pageSize`は固定の`20`としてクライアントには公開しない設計にした。将来「1ページの件数を変えたい」要望が出た場合は、別途`pageSize`パラメータの公開を検討する必要がある。
4. **新規ErrorCodeの命名**：既存の`FORBIDDEN_SELF_ROLE_CHANGE`等の「状況特化型」の命名パターンに合わせ、`CONFLICT_INVALID_STATUS`（汎用：編集・削除・提出時の状態不整合）と`CONFLICT_MANAGER_NOT_SET`（提出時の上長未設定、特化）の2種類に分けた。`CONFLICT_INVALID_STATUS`は今後PBI4（承認・差し戻し(`RETURNED`)。「申請中以外を承認・差し戻しすると409」）でも再利用できる汎用コードとして設計した（PBI4側で別名が必要と判断された場合は要相談）。
5. **削除は論理削除か物理削除か**：PBI3の受け入れ条件は「削除できる」のみで、監査要件（CLAUDE.md「誰が・いつ・何をしたかを後から追える」）との整合を考えると、下書き段階のデータは物理削除で問題ないと判断した（下書きは承認フロー開始前であり、そもそも監査対象になるような重要な操作の痕跡ではないため）。ただし監査ログ実装（PBI6）時に「削除された下書きも記録すべきか」の方針確認が必要になる可能性がある。
6. **将来PBI4・5で追加が想定されるカラム**（今回は追加しない）：承認者ID（`approvedById`）・承認日時（`approvedAt`）・差し戻し理由（`rejectionReason`）・経理確認者ID／日時等。これらはPBI4・5で要件が確定した時点で追加する方が、カラムの意味とマイグレーション履歴が対応して読みやすいと判断し、今回は追加しなかった。
