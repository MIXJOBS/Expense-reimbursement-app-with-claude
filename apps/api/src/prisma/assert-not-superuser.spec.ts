// PBI6 セキュリティレビュー 要修正-1(c)：本番でスーパーユーザー接続なら起動を止める。
import { assertNotSuperuserInProduction } from './assert-not-superuser';

function clientReturning(isSuperuser: string | undefined) {
  const $queryRaw = jest
    .fn()
    .mockResolvedValue(
      isSuperuser === undefined ? [] : [{ is_superuser: isSuperuser }],
    );
  return { client: { $queryRaw } as never, $queryRaw };
}

describe('assertNotSuperuserInProduction', () => {
  it('本番でスーパーユーザー（on）なら例外を投げる', async () => {
    const { client } = clientReturning('on');
    await expect(
      assertNotSuperuserInProduction(client, 'production'),
    ).rejects.toThrow(/must not be a superuser/);
  });

  it('本番で判定できない（行なし）場合も、安全側に倒して例外を投げる', async () => {
    const { client } = clientReturning(undefined);
    await expect(
      assertNotSuperuserInProduction(client, 'production'),
    ).rejects.toThrow();
  });

  it('本番でスーパーユーザーでなければ（off）通る', async () => {
    const { client } = clientReturning('off');
    await expect(
      assertNotSuperuserInProduction(client, 'production'),
    ).resolves.toBeUndefined();
  });

  it.each(['development', 'test', undefined])(
    '%s ではスーパーユーザーでも止めない（DBへ問い合わせもしない）',
    async (env) => {
      const { client, $queryRaw } = clientReturning('on');
      await expect(
        assertNotSuperuserInProduction(client, env),
      ).resolves.toBeUndefined();
      expect($queryRaw).not.toHaveBeenCalled();
    },
  );
});
