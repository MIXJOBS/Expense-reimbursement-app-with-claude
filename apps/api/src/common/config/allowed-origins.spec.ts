// ALLOWED_ORIGINS の起動チェック。
// 本番扱いは「NODE_ENV が development・test のどちらでもない場合（未設定を含む）」。
import {
  assertAllowedOriginsConfigured,
  getAllowedOrigins,
} from './allowed-origins';

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('ALLOWED_ORIGINS の起動チェック', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    setEnv('NODE_ENV', originalNodeEnv);
    setEnv('ALLOWED_ORIGINS', originalAllowedOrigins);
  });

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
    beforeEach(() => setEnv('NODE_ENV', env));

    it.each([undefined, '', '   ', ' , '])(
      'ALLOWED_ORIGINS=%j では起動を止める',
      (origins) => {
        setEnv('ALLOWED_ORIGINS', origins);
        expect(() => assertAllowedOriginsConfigured()).toThrow(
          /ALLOWED_ORIGINS/,
        );
      },
    );

    it.each([undefined, '', '   '])(
      'ALLOWED_ORIGINS=%j では開発用の既定値を使わず例外を投げる',
      (origins) => {
        setEnv('ALLOWED_ORIGINS', origins);
        expect(() => getAllowedOrigins()).toThrow(/ALLOWED_ORIGINS/);
      },
    );

    it('ALLOWED_ORIGINS が設定されていれば起動でき、その値だけを許可する', () => {
      setEnv('ALLOWED_ORIGINS', 'https://example.com');
      expect(() => assertAllowedOriginsConfigured()).not.toThrow();
      expect([...getAllowedOrigins()]).toEqual(['https://example.com']);
    });
  });

  it.each(['development', 'test'])(
    'NODE_ENV=%s では未設定でも起動でき、開発用の既定値を使う',
    (env) => {
      setEnv('NODE_ENV', env);
      setEnv('ALLOWED_ORIGINS', undefined);
      expect(() => assertAllowedOriginsConfigured()).not.toThrow();
      expect([...getAllowedOrigins()]).toEqual(['http://localhost:5173']);
    },
  );
});
