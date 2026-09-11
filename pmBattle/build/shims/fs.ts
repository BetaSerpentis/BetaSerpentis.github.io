// build/shims/fs.ts — 浏览器端 fs 模块 shim（PS 引擎仅用到 readdirSync 等少量 API）
// readdirSync 对 mods 目录返回已打包的世代 mod 列表（当前仅 gen8，极巨化）。
export function readdirSync(dir?: string): string[] {
  if (String(dir || '').includes('mods')) return ['gen8'];
  return [];
}
export function readFileSync(_file: string, _opts?: any): string { return ''; }
export function existsSync(_file: string): boolean { return false; }
export function statSync(_file: string) { return { isDirectory: () => false, isFile: () => true }; }
export function writeFileSync() {}
export function mkdirSync() {}
export function copyFileSync() {}
export function createReadStream() { return null; }
export function createWriteStream() { return null; }
export const promises = { readFile: async () => '', readdir: async () => [] as string[] };
export default { readdirSync, readFileSync, existsSync, statSync };
