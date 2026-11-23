import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode, type ApiErrorBody } from '@expense/shared';

// 横断ルール3: エラー形式は { code, message } に統一する。
// 500の詳細（スタックトレース・SQL等）はクライアントに返さない。
// 横断ルール5: ログにパスワード・Cookie・トークンを出力しない
// （この層ではリクエストボディ等をログに出さないようにしている）。
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = this.toErrorBody(exception, status);
      response.status(status).json(body);
      return;
    }

    // 想定外の例外（NestJSの例外クラスを経由しないもの）は500として扱い、
    // 内部情報を一切返さない。サーバー側ログにのみ詳細を出す。
    this.logger.error(
      exception instanceof Error ? exception.message : 'Unknown error',
      exception instanceof Error ? exception.stack : undefined,
    );

    const body: ApiErrorBody = {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'サーバー内部でエラーが発生しました。',
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  private toErrorBody(exception: HttpException, status: number): ApiErrorBody {
    const exceptionResponse = exception.getResponse();

    // Service/Controller側で throw new XxxException({ code, message }) のように
    // { code, message } 形式を渡しているケース（意図的に投げたエラー）。
    if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'code' in exceptionResponse &&
      'message' in exceptionResponse
    ) {
      const code = (exceptionResponse as { code: unknown }).code;
      const message = (exceptionResponse as { message: unknown }).message;
      return {
        code:
          typeof code === 'string'
            ? (code as ApiErrorBody['code'])
            : ErrorCode.INTERNAL_ERROR,
        message: Array.isArray(message) ? message.join(', ') : String(message),
      };
    }

    // ValidationPipe（class-validator）が投げる BadRequestException は
    // message がエラー文字列配列になっているため、VALIDATION_ERRORにマッピングする。
    if (status === HttpStatus.BAD_REQUEST) {
      const message =
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null &&
        'message' in exceptionResponse
          ? (exceptionResponse as { message: unknown }).message
          : exception.message;
      return {
        code: ErrorCode.VALIDATION_ERROR,
        message: Array.isArray(message) ? message.join(', ') : String(message),
      };
    }

    // NestJS標準の例外（UnauthorizedException等）で、code未指定のもの。
    const fallbackCodeByStatus: Partial<Record<number, ApiErrorBody['code']>> =
      {
        [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_UNAUTHORIZED,
        [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
        [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
        // @nestjs/throttlerが投げるThrottlerException（IPアドレス単位の
        // ログイン試行レート制限）。code未指定のためここでマッピングする。
        [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.TOO_MANY_REQUESTS,
      };

    return {
      code: fallbackCodeByStatus[status] ?? ErrorCode.INTERNAL_ERROR,
      message: exception.message,
    };
  }
}
