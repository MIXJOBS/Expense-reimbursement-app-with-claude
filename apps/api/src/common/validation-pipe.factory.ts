import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ErrorCode } from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// 横断ルール3: エラー形式は { code, message } に統一する。
// ValidationPipeのデフォルトのエラー形式（message: string[]）だとcodeを持たないため、
// exceptionFactoryで明示的に { code: VALIDATION_ERROR, message } を持つ
// BadRequestExceptionを投げる（HttpExceptionFilter側でそのまま変換される）。
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) => {
      return new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: formatValidationErrors(errors),
      });
    },
  });
}

function formatValidationErrors(errors: ValidationError[]): string {
  const messages = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
  return messages.length > 0 ? messages.join(', ') : '入力内容が不正です。';
}
