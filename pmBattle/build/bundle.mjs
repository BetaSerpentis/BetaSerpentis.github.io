// build/bundle.mjs — 用 esbuild 把 PS 引擎（sim + data + text）打包成浏览器 ESM bundle
// 用法: node build/bundle.mjs
import esbuild from 'esbuild';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../js/vendor');

mkdirSync(OUT_DIR, { recursive: true });

// 文本替换：把 Node 的 require 调用替换为 browser-shim 注入的 globalThis 函数
const requirePlugin = {
  name: 'ps-browser-require',
  setup(build) {
    build.onLoad({ filter: /sim[\\/]dex\.ts$/ }, async (args) => {
      let src = await readFileSync(args.path, 'utf8');
      src = src.replace(/require\(/g, 'globalThis.__psRequire(');
      return { contents: src, loader: 'ts' };
    });
    build.onLoad({ filter: /sim[\\/]dex-text\.ts$/ }, async (args) => {
      let src = await readFileSync(args.path, 'utf8');
      src = src.replace(/require\.resolve\(/g, 'globalThis.__psResolve(');
      src = src.replace(/require\(/g, 'globalThis.__psRequireText(');
      return { contents: src, loader: 'ts' };
    });
    build.onLoad({ filter: /sim[\\/]dex-formats\.ts$/ }, async (args) => {
      let src = await readFileSync(args.path, 'utf8');
      src = src.replace(/require\(/g, 'globalThis.__psRequire(');
      // 只保留已打包 mod（gen9）的格式，跳过引用了未打包 mod（gen9predlc 等）的格式
      src = src.replace(/if \(!this\.dex\.dexes\[format\.mod\]\) throw new Error\([^)]*\);/g, 'if (!this.dex.dexes[format.mod]) continue;');
      return { contents: src, loader: 'ts' };
    });
    // teams.ts 的动态 require 用于随机队伍生成（本作不用），替换掉避免 esbuild 解析
    // 它们引入 data/mods + lib 服务器文件
    build.onLoad({ filter: /sim[\\/]teams\.ts$/ }, async (args) => {
      let src = await readFileSync(args.path, 'utf8');
      src = src.replace(/require\(/g, 'globalThis.__psRequire(');
      return { contents: src, loader: 'ts' };
    });
    // prng.ts 的 node:crypto 仅在无 WebCrypto 时使用，替换为直接取 globalThis.crypto
    build.onLoad({ filter: /sim[\\/]prng\.ts$/ }, async (args) => {
      let src = await readFileSync(args.path, 'utf8');
      src = src.replace("require('node:crypto')", 'globalThis.crypto');
      return { contents: src, loader: 'ts' };
    });
  },
};

await esbuild.build({
  entryPoints: [path.resolve(__dirname, 'entry.ts')],
  bundle: true,
  outfile: path.join(OUT_DIR, 'ps-engine.js'),
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  // 覆盖 tsconfig：不读 PS 根 tsconfig（其 include 会拖入 server/lib 等大量文件）
  tsconfigRaw: { compilerOptions: { target: 'es2020', module: 'esnext', jsx: 'react' } },
  alias: {
    fs: path.resolve(__dirname, 'shims/fs.ts'),
    path: path.resolve(__dirname, 'shims/path.ts'),
    'node:crypto': path.resolve(__dirname, 'shims/node-crypto.ts'),
    'node:util': path.resolve(__dirname, 'shims/node-util.ts'),
    'ts-chacha20': path.resolve(__dirname, 'shims/chacha20.ts'),
  },
  define: {
    __dirname: '""',
  },
  plugins: [requirePlugin],
  logLevel: 'info',
});

console.log('✅ PS 引擎已打包到', path.join(OUT_DIR, 'ps-engine.js'));
