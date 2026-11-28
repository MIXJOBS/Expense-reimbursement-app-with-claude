// PBI6 セキュリティレビュー 要修正-2：想定外の例外のログに、例外メッセージ
// （Prismaでは入力値を含み得る）を出さない。クライアントへの500レスポンスも内部情報なし。
import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '@expense/shared';
import {
  HttpExceptionFilter,
  describeUnexpectedException,
} from './http-exception.filter';

const SECRET = 'secret-person@example.com';

function createHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter（想定外の例外のログ）', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Prismaの例外：ログにはエラー名・コード・位置情報だけで、メッセージ（入力値）は出ない', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      `Invalid \`prisma.auditLog.create()\` invocation: actorEmail: "${SECRET}"`,
      { code: 'P2002', clientVersion: 'test' },
    );
    const { host, status, json } = createHost();

    new HttpExceptionFilter().catch(error, host);

    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('Invalid');
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [summary, stack] = loggerError.mock.calls[0] as [string, string];
    expect(summary).toBe(
      'Unexpected exception: name=PrismaClientKnownRequestError code=P2002',
    );
    // 位置情報（at ...）の行だけが残る。
    expect(stack).toMatch(/^\s+at /);
    stack.split('\n').forEach((line) => expect(line).toMatch(/^\s+at /));

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'サーバー内部でエラーが発生しました。',
    });
  });

  it('メッセージに改行と "    at " を含めても、位置情報として出力されない', () => {
    const error = new Error(`boom\n    at ${SECRET} (fake.ts:1:1)`);
    const { host } = createHost();

    new HttpExceptionFilter().catch(error, host);

    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(SECRET);
  });

  it('Error以外が投げられても、値をログに出さない', () => {
    const { host, json } = createHost();

    new HttpExceptionFilter().catch({ secret: SECRET }, host);

    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(SECRET);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.INTERNAL_ERROR }),
    );
  });

  it('コードに見えない値（入力値が入り得る）は出さない', () => {
    const error = Object.assign(new Error('x'), { code: SECRET });
    expect(describeUnexpectedException(error).summary).toBe(
      'Unexpected exception: name=Error',
    );
  });

  it('HttpException（想定内）は従来どおり、ログを出さず { code, message } を返す', () => {
    const { host, status, json } = createHost();

    new HttpExceptionFilter().catch(new BadRequestException(['bad']), host);

    expect(loggerError).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'bad',
    });
  });
});
