import {
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALL_EXPENSE_CATEGORIES,
  EXPENSE_AMOUNT_MAX,
  EXPENSE_AMOUNT_MIN,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  type ExpenseCategory,
  type UpsertExpenseRequestBody,
} from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// packages/shared の UpsertExpenseRequestBody と構造を一致させる。
// status・applicantId はここに項目を設けない（サーバーが決める値のため、
// 送られてきた場合は forbidNonWhitelisted により 400 VALIDATION_ERROR になる）。
export class UpsertExpenseRequestDto implements UpsertExpenseRequestBody {
  // 利用日。ISO8601の日付文字列であることのみをここで検証する
  // （タイムゾーン・時刻の有無はPrisma側の @db.Date 変換に委ねる）。
  @IsDateString()
  expenseDate: string;

  // 金額は1円〜1,000,000円の整数（受け入れ条件）。
  // @IsInt() は小数（100.5等）を拒否する。
  @IsInt()
  @Min(EXPENSE_AMOUNT_MIN)
  @Max(EXPENSE_AMOUNT_MAX)
  amount: number;

  // 科目は ALL_EXPENSE_CATEGORIES に含まれる値のみ許可する。
  // 型チェックのみでは未定義の文字列がそのままDBに保存されてしまうため、
  // @IsIn() で値そのものを照合する（docs/api/pbi-3.md 実装時必須要件）。
  @IsIn(ALL_EXPENSE_CATEGORIES)
  category: ExpenseCategory;

  // 内容は200文字まで。
  @IsString()
  @MaxLength(EXPENSE_DESCRIPTION_MAX_LENGTH)
  description: string;
}
