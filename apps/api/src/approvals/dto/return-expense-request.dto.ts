import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  EXPENSE_RETURN_REASON_MAX_LENGTH,
  type ReturnExpenseRequestBody,
} from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// reason以外（statusなど）が送られた場合は forbidNonWhitelisted により 400 になる。
export class ReturnExpenseRequestDto implements ReturnExpenseRequestBody {
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXPENSE_RETURN_REASON_MAX_LENGTH)
  reason: string;
}
