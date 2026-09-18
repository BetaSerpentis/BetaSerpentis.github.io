#!/usr/bin/env node
/**
 * ES 模块语法守卫。
 *
 * 为什么需要它：
 * `node --check <file>.js` 对本仓库这些文件会给出**假阳性** —— 包内没有 "type": "module"，
 * node 先按 CommonJS 判定，模板字符串里的语法错误不会被报出来。
 * 真实案例：SYSTEM_PROMPT 模板字符串里多写了一个未转义的反引号，
 * `node --check` 说“语法 OK”，但浏览器直接抛
 *   AISystemPrompt.js:9 Uncaught SyntaxError: Unexpected identifier 'currentMarks'
 * 整条 import 链失败 → 卡牌页卡死、卡图不显示、UI 不全。
 *
 * 做法：用 vm.SourceTextModule **只解析不执行**（不会触发模块副作用），
 * 按真正的 ES 模块语法校验，能精确复现浏览器那类报错。
 *
 * 用法：
 *   node --experimental-vm-modules ptcg/tools/check-module-syntax.mjs
 *   npm run ptcg:check-syntax
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PTCG = path.resolve(__dirname, '..');

const ROOTS = [
  path.join(PTCG, 'js'),
  path.join(PTCG, 'battle', 'js'),
  path.join(PTCG, 'tools'),
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(m?js)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

if (typeof vm.SourceTextModule !== 'function') {
  console.error('需要 --experimental-vm-modules 才能做 ES 模块语法校验。');
  console.error('请用: node --experimental-vm-modules ptcg/tools/check-module-syntax.mjs');
  process.exit(2);
}

const files = ROOTS.flatMap(r => walk(r));
let failed = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    // 只解析，不执行：既校验 ES 模块语法，也不会触发任何运行时副作用
    new vm.SourceTextModule(src, { identifier: file });
  } catch (err) {
    failed++;
    const rel = path.relative(PTCG, file).replace(/\\/g, '/');
    console.error(`✗ ${rel}`);
    console.error(`    ${String(err.message).split('\n')[0]}`);
  }
}

console.log(`ES 模块语法检查: ${files.length - failed}/${files.length} 通过`);
if (failed) {
  console.error(`${failed} 个文件存在语法错误。`);
  process.exit(1);
}
