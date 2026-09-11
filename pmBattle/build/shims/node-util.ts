// build/shims/node-util.ts — 浏览器端 node:util shim（PS 仅用到 isDeepStrictEqual）
export function isDeepStrictEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  if (protoA !== protoB && !(protoA === null && protoB === Object.prototype) && !(protoB === null && protoA === Object.prototype)) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isDeepStrictEqual(a[i], b[i])) return false;
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepStrictEqual(a[k], b[k])) return false;
  }
  return true;
}

export default { isDeepStrictEqual };
