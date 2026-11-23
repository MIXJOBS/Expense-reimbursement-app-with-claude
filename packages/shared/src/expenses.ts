// 経費申請（ExpenseRequest）関連の定数・型。
// PBI3（経費申請の登録・編集）・PBI4（承認・差し戻し）で確定した仕様を反映。
//
// ステータス遷移（CLAUDE.md参照）：
//   下書き(DRAFT) → 申請中(SUBMITTED) → 承認済み(APPROVED) ／ 差し戻し(RETURNED) → 経理確認済み(ACCOUNTING_CONFIRMED)
// PBI3のスコープは DRAFT の作成・編集・削除 と、DRAFT/RETURNED→SUBMITTED の提出。
// PBI4のスコープは SUBMITTED→APPROVED（承認） と SUBMITTED→RETURNED（差し戻し）。
// ACCOUNTING_CONFIRMEDへの遷移はPBI5のスコープだが、
// CLAUDE.mdのフロー全体を見据えて値自体は先に定義しておく
// （DBのstatusカラムが後から取り得る値の集合を、今のうちに１箇所で管理する）。
//
// 命名についての補足（PBIレビューで確定）：
// 当初「差し戻し」は REJECTED としていたが、「申請者が編集して再提出できる」業務上の
// 意味（却下して終わりではなく、直してもう一度出してね、という意味）と英語の字面が
// 合わないため RETURNED にリネームした。
export const ExpenseStatus = {
  DRAFT: 'DRAFT', // 下書き（申請者のみ編集・削除・提出可）
  SUBMITTED: 'SUBMITTED', // 申請中（上長の承認待ち。PBI4で承認・差し戻し対象になる）
  APPROVED: 'APPROVED', // 承認済み（PBI4）
  RETURNED: 'RETURNED', // 差し戻し（PBI4。申請者が編集して再提出できる。削除は不可）
  ACCOUNTING_CONFIRMED: 'ACCOUNTING_CONFIRMED', // 経理確認済み（PBI5以降）
} as const;

export type ExpenseStatus = (typeof ExpenseStatus)[keyof typeof ExpenseStatus];

// 編集・削除・提出がそれぞれ許可されているステータスのポジティブリスト。
//
// 設計判断（PBIレビューで確定）：
// 当初は「ロックされる（禁止される）ステータス」の否定形リスト1つ
// （EXPENSE_LOCKED_FOR_EDIT_STATUSES）を編集・削除で共用していたが、
// 「削除だけはRETURNED（差し戻し中）も禁止」という操作ごとの差分が生まれたため、
// 否定形1つの共用では表現できなくなった。否定形を操作ごとに増やす（LOCKED_FOR_DELETE等）
// よりも、「許可されているステータス」を操作ごとに明示するポジティブリスト3つに
// 分けたほうが、各操作で何が起きるかが一覧して分かりやすいと判断した。
//
// - 編集可能：DRAFT, RETURNED（差し戻しは直して再提出できる）
// - 削除可能：DRAFT のみ（一度でも提出した申請は、上長とのやりとりの記録として
//   残す必要があるため、差し戻し中（RETURNED）であっても削除不可とする）
// - 提出可能：DRAFT, RETURNED（新規提出・再提出の両方）
// 上記以外のステータスでの操作は 409 CONFLICT_INVALID_STATUS で拒否する。
export const EXPENSE_EDITABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.DRAFT, ExpenseStatus.RETURNED];

export const EXPENSE_DELETABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.DRAFT];

export const EXPENSE_SUBMITTABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.DRAFT, ExpenseStatus.RETURNED];

// 承認・差し戻しが許可されているステータスのポジティブリスト（PBI4）。
// - 承認可能：SUBMITTED のみ
// - 差し戻し可能：SUBMITTED のみ
// 受け入れ条件「『申請中』以外の申請を承認・差し戻しすると409」「承認と差し戻しが
// 同時に来ても、成功するのは片方だけ（もう片方は409）」を、PBI3と同じ「条件付き
// updateMany（where に status: { in: [...] } を含める）」の形で実現する
// （どちらも対象をSUBMITTEDのみに絞るため、一方が先にSUBMITTED→APPROVED/RETURNEDに
// 変更した後に他方のupdateManyを実行すると対象行が0件になり、自然に409になる）。
export const EXPENSE_APPROVABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.SUBMITTED];

export const EXPENSE_RETURNABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.SUBMITTED];

// 承認者（上長）の一覧・閲覧対象となるステータス（受け入れ条件：
// 「直属の部下の『申請中』の申請だけを一覧・閲覧できる」）。
export const EXPENSE_APPROVER_VISIBLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.SUBMITTED];

// 差し戻し理由の文字数制約（受け入れ条件：500文字まで）。
export const EXPENSE_RETURN_REASON_MAX_LENGTH = 500;

// 科目（科目区分）。DBの category カラムにもこの値をそのまま格納する。
export const ExpenseCategory = {
  TRANSPORTATION: 'TRANSPORTATION', // 交通費
  ENTERTAINMENT: 'ENTERTAINMENT', // 交際費
  SUPPLIES: 'SUPPLIES', // 消耗品費
  OTHER: 'OTHER', // その他
} as const;

export type ExpenseCategory = (typeof ExpenseCategory)[keyof typeof ExpenseCategory];

export const ALL_EXPENSE_CATEGORIES: ExpenseCategory[] = Object.values(ExpenseCategory);

// 金額の制約（受け入れ条件：1円〜1,000,000円の整数）。
export const EXPENSE_AMOUNT_MIN = 1;
export const EXPENSE_AMOUNT_MAX = 1_000_000;

// 内容（詳細説明）の文字数制約。
export const EXPENSE_DESCRIPTION_MAX_LENGTH = 200;

// 一覧取得のページネーション（受け入れ条件：1ページ20件）。
// クエリパラメータ名は page（1始まり）・pageSize は固定値のためクライアントには
// 公開しない（GET /admin/users の「サーバー側ハードリミットのみ」と同じ考え方で、
// 1ページの件数をクライアントが自由に指定できる作りにはしない＝大量取得によるDoS・
// 他人のデータの総当たり的な探索を防ぐ）。
export const EXPENSE_LIST_PAGE_SIZE = 20;

// GET /expenses のクエリパラメータ型（プレーンなTS型）。
// class-validatorのデコレータ付きDTOクラスはapps/api側で別途定義する。
export interface ListExpenseRequestsQuery {
  // 1始まりの整数。未指定時は1。
  // 実装時、apps/api側のDTOクラスではclass-validatorで「1以上の整数であること」を
  // 検証する（例：@IsInt() @Min(1)）。page=0・page=-1（1未満）、page=abc（数値でない）は
  // いずれも 400 VALIDATION_ERROR になる想定（class-validatorの型変換・検証に委譲し、
  // Controller/Service側で個別にtry-catchするような実装はしない）。
  page?: number;
}

// 経費申請1件分のレスポンス型。
// 申請者視点（GET /expenses, GET /expenses/:id等）・承認者視点
// （GET /approvals, GET /approvals/:id等。PBI4で追加）の
// 両方で同じ型を使う（見える列・権限はエンドポイント側のwhere条件で制御するため、
// レスポンスの形自体は分けない）。
export interface ExpenseRequestDto {
  id: string;
  applicantId: string;
  // 承認者ID（PBI4で追加）。SUBMITTEDに遷移した時点でそのときの申請者のmanagerIdが
  // 保存される。DRAFT段階（一度も提出されていない申請）ではnull。
  approverId: string | null;
  expenseDate: string; // ISO8601の日付（例: "2026-11-23"）。利用日。
  amount: number; // 円の整数
  category: ExpenseCategory;
  description: string;
  status: ExpenseStatus;
  // 差し戻し理由（PBI4で追加）。差し戻されたことが一度もない申請はnull。
  // 差し戻し→再提出後も、次に差し戻されるまでは直前の値が残る
  // （詳細はdocs/api/pbi-4.mdの「判断に迷ったところ」参照）。
  returnReason: string | null;
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
}

// GET /expenses のレスポンス型。
export interface ExpenseRequestListResponseDto {
  items: ExpenseRequestDto[];
  total: number; // 自分の申請の総件数（ページネーションのため）
  page: number;
  pageSize: number;
}

// POST /expenses, PUT /expenses/:id のリクエストボディ型（プレーンなTS型）。
// status・applicantId はここに項目を設けない（サーバーが決める値のため、
// リクエストボディで受け取るとValidationPipeのforbidNonWhitelistedで400になる想定）。
export interface UpsertExpenseRequestBody {
  expenseDate: string; // ISO8601の日付
  amount: number;
  // 実装時必須要件：apps/api側のDTOクラスでは、categoryが文字列型であることに加えて
  // ALL_EXPENSE_CATEGORIES に含まれる値であることを必ず照合する
  // （例：@IsIn(ALL_EXPENSE_CATEGORIES)）。型チェックだけでは未定義の文字列
  // （例："FOO"）がDBのcategoryカラム（String型）にそのまま保存されてしまうため。
  category: ExpenseCategory;
  description: string;
}

// ============================================================
// PBI4（承認・差し戻し）
// ============================================================

// GET /approvals のクエリパラメータ型（プレーンなTS型）。
// GET /expenses と同じ考え方で page のみを公開し、pageSize は固定の
// EXPENSE_LIST_PAGE_SIZE とする（クライアントには公開しない）。
export interface ListApprovalExpenseRequestsQuery {
  page?: number;
}

// GET /approvals のレスポンス型は、既存の ExpenseRequestListResponseDto
// （GET /expenses と共用）を使う。「直属の部下の『申請中』の申請だけ」が対象のため、
// items は必ず approverId = 自分 かつ status = SUBMITTED の申請のみになる。
// total は「自分が承認対象の申請中の申請」の総件数（他の承認者・他ステータスを含まない）。

// POST /approvals/:id/return のリクエストボディ型（プレーンなTS型）。
// 差し戻しには理由が必須（受け入れ条件：500文字まで）。
export interface ReturnExpenseRequestBody {
  reason: string;
}
