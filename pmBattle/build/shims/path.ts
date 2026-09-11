// build/shims/path.ts — 浏览器端 path 模块 shim
// PS 引擎用 path.resolve 构造数据文件路径（如 '../data'），这里做确定性归一化。

export const sep = '/';
export const delimiter = ':';

export function resolve(...parts: any[]): string {
  const segs: string[] = [];
  for (const p of parts) {
    const s = String(p ?? '');
    if (!s) continue;
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { segs.pop(); continue; }
      segs.push(seg);
    }
  }
  return '/' + segs.join('/');
}

export function join(...parts: any[]): string {
  return parts.map(p => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

export function basename(p: string): string {
  const segs = String(p).split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}

export function dirname(p: string): string {
  const segs = String(p).split('/').filter(Boolean);
  segs.pop();
  return '/' + segs.join('/');
}

export function extname(p: string): string {
  const m = String(p).match(/\.[a-z0-9]+$/i);
  return m ? m[0] : '';
}

export function normalize(p: string): string { return resolve(p); }
export function isAbsolute(_p: string): boolean { return true; }
export function relative(_from: string, to: string): string { return String(to); }
export function parse(p: string) {
  return { root: '/', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p).replace(/\.[a-z0-9]+$/i, '') };
}
export function format(po: any): string { return `${po.dir || ''}/${po.base || ''}`; }

export default { sep, resolve, join, basename, dirname, extname, normalize, isAbsolute, relative, parse, format };
