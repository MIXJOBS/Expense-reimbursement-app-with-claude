// 起動時の安全チェックで使う「本番扱いかどうか」の判定。判定はここ1か所にまとめる。
//
// 安全側に倒し、NODE_ENV が development・test のどちらでもない場合は本番扱いにする
// （未設定・空文字・'prod' などの打ち間違いを含む。PO判断 2026-11-28）。
// 大文字小文字や前後の空白の違いも許容せず、完全一致だけを非本番とする。
const NON_PRODUCTION_ENVS: readonly string[] = ['development', 'test'];

// 引数を受け取らない（undefined を渡すと既定値に置き換わり、未設定の判定を
// 誤るような呼び方を作らないため）。
export function isProductionEnv(): boolean {
  return !NON_PRODUCTION_ENVS.includes(process.env.NODE_ENV ?? '');
}
