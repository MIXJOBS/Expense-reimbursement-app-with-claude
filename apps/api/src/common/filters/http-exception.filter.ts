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
    // 内部情報を一切返さない。サーバー側ログには、エラー名・コード・スタックの
    // 位置情報だけを出す。例外メッセージ（Prismaでは入力値やクエリ周辺のコードを
    // 含み得る）は出さない（横断ルール5・PBI6 要修正-2）。
    const { summary, stackLocations } = describeUnexpectedException(exception);
    this.logger.error(summary, stackLocations);

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

// 想定外の例外を、機微情報を含まない形に要約する（ログ用）。
// - エラー名：コンストラクタ名・name のうち、識別子として妥当な文字だけ。
// - コード：Prisma（P2002 等）・pg 由来の短い英数字コードだけ。
// - スタック：先頭のメッセージ部分を捨て、"    at ..." の位置情報の行だけ。
export function describeUnexpectedException(exception: unknown): {
  summary: string;
  stackLocations: string | undefined;
} {
  if (!(exception instanceof Error)) {
    return {
      summary: 'Unexpected exception: name=unknown',
      stackLocations: undefined,
    };
  }
  const name = sanitizeToken(exception.name, 64) ?? 'Error';
  const code = sanitizeToken((exception as { code?: unknown }).code, 16);
  const summary = `Unexpected exception: name=${name}${code ? ` code=${code}` : ''}`;
  // メッセージに改行＋"    at " を含む入力があっても位置情報に紛れないよう、
  // 先にメッセージ部分を取り除いてから、位置情報の行だけを残す。
  const rawStack = exception.stack ?? '';
  const withoutMessage = exception.message
    ? rawStack.split(exception.message).join('')
    : rawStack;
  const locations = withoutMessage
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .join('\n');
  return { summary, stackLocations: locations || undefined };
}

function sanitizeToken(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' &&
    value.length <= maxLength &&
    /^[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : undefined;
}
