import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  AUDIT_ACTOR_EMAIL_MAX_LENGTH,
  type LoginRequestBody,
} from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// packages/shared の LoginRequestBody と構造を一致させる。
export class LoginDto implements LoginRequestBody {
  // 失敗時は監査ログのactorEmail（254文字まで）に残すため、上限をここでも検証する。
  @IsEmail()
  @MaxLength(AUDIT_ACTOR_EMAIL_MAX_LENGTH)
  email: string;

  // argon2に巨大な入力を渡さないよう上限を付ける（PBI6 軽微-5）。
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}
