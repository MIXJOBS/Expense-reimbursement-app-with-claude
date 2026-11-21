import { IsEmail, IsString, MinLength } from 'class-validator';
import type { LoginRequestBody } from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// packages/shared の LoginRequestBody と構造を一致させる。
export class LoginDto implements LoginRequestBody {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}
