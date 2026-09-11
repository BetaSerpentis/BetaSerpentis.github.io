// build/shims/node-crypto.ts — 浏览器端 node:crypto shim
// prng.ts 里仅在 typeof crypto === 'undefined' 时才 require('node:crypto')，
// 浏览器恒有 WebCrypto，此 shim 仅为让 esbuild 解析通过。
export const webcrypto = globalThis.crypto;
export default globalThis.crypto;
export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  if (globalThis.crypto) globalThis.crypto.getRandomValues(buf);
  return buf;
}
