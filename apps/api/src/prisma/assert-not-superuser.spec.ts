// PBI6 セキュリティレビュー 要修正-1(c)：本番でスーパーユーザー接続なら起動を止める。
// 本番扱いは「NODE_ENV が development・test のどちらでもない場合（未設定を含む）」。
import { assertNotSuperuserInProduction } from './assert-not-superuser';

function clientReturning(isSuperuser: string | undefined) {
  const $queryRaw = jest
    .fn()
    .mockResolvedValue(
      isSuperuser === undefined ? [] : [{ is_superuser: isSuperuser }],
    );
  return { client: { $queryRaw } as never, $queryRaw };
}

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
}

describe('assertNotSuperuserInProduction', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => setNodeEnv(originalNodeEnv));

  describe.each([
    'production',
    undefined,
    '',
    'prod',
    'staging',
    'Production',
    'Development',
    'development ',
  ])('NODE_ENV=%j は本番扱い', (env) => {
    beforeEach(() => setNodeEnv(env));

    it('スーパーユーザー（on）なら例外を投げ、手順書を案内する', async () => {
      const { client, $queryRaw } = clientReturning('on');
      const result = assertNotSuperuserInProduction(client);
      await expect(result).rejects.toThrow(/must not be a superuser/);
      await expect(result).rejects.toThrow(
        /docs\/ops\/production-db-roles\.md/,
      );
      expect($queryRaw).toHaveBeenCalledTimes(1);
    });

    it('判定できない（行なし）場合も、安全側に倒して例外を投げる', async () => {
      const { client } = clientReturning(undefined);
      await expect(assertNotSuperuserInProduction(client)).rejects.toThrow();
    });

    it('スーパーユーザーでなければ（off）通る', async () => {
      const { client } = clientReturning('off');
      await expect(
        assertNotSuperuserInProduction(client),
      ).resolves.toBeUndefined();
    });
  });

  it.each(['development', 'test'])(
    'NODE_ENV=%s ではスーパーユーザーでも止めない（DBへ問い合わせもしない）',
    async (env) => {
      setNodeEnv(env);
      const { client, $queryRaw } = clientReturning('on');
      await expect(
        assertNotSuperuserInProduction(client),
      ).resolves.toBeUndefined();
      expect($queryRaw).not.toHaveBeenCalled();
    },
  );
});
