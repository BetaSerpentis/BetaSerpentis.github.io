// ptcg 战斗 UI 的真实浏览器 DOM 回归测试
//   覆盖：① 场地列表道具首字（放能量前） ② 昏厥后由玩家选择上场宝可梦
//         ③ 对方回合操作区全部置灰 ④ 战斗区道具方形图标（在能量前、不与能量混淆）
// 运行：npm run test:ptcg-ui
// 依赖 playwright；未安装时优雅跳过（不影响主测试链）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let chromium = null;
const _load = async (spec) => {
  const m = await import(spec);
  return m.chromium || m.default?.chromium || null;
};
for (const spec of ['playwright', '../../../pmBattle/node_modules/playwright/index.js']) {
  try { chromium = await _load(spec); if (chromium) break; } catch { /* 继续尝试下一个 */ }
}
if (!chromium) {
  console.log('  ⚠ 未找到 playwright，跳过 ptcg 战斗 UI DOM 测试');
  process.exit(0);
}

const BASE = process.env.BASE || 'http://localhost:3000';
let serverProc = null;
const alive = async () => {
  try { const r = await fetch(BASE + '/ptcg/', { signal: AbortSignal.timeout(2500) }); return r.ok; }
  catch { return false; }
};
if (!(await alive())) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  serverProc = spawn(process.execPath, ['server.js'], { cwd: repoRoot, stdio: 'ignore' });
  for (let i = 0; i < 20 && !(await alive()); i++) await new Promise(r => setTimeout(r, 400));
}
const done = async (code) => { try { serverProc?.kill(); } catch { /* ignore */ } await new Promise(r => setTimeout(r, 150)); process.exit(code); };
if (!(await alive())) { console.log('  ⚠ 本地服务未启动，跳过 ptcg 战斗 UI DOM 测试'); done(0); }

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push('console: ' + m.text()); });

await page.goto(BASE + '/ptcg/', { waitUntil: 'domcontentloaded' });

await page.waitForTimeout(2000);
await page.click('button:has-text("进入对战")');
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const mod = await import('/ptcg/battle/js/main.js');
  const proto = mod.PTCGBattleApp.prototype;
  const results = [];
  const ok = (name, cond, extra = '') => results.push({ name, pass: !!cond, extra });

  const mon = (over = {}) => Object.assign({
    cardId: 'X1', name: '测试宝可梦', hp: 100, maxHp: 120, energy: ['草能量', '火能量'],
    tool: null, status: null, retreatCost: 1, attacks: [],
  }, over);
  const tool = { cardId: 'T1', name: '豪华斗篷' };

  const build = (p1Mon, p2Mon) => {
    const app = Object.create(proto);
    app.resolver = {
      getCard: id => (id === 'T1' ? { name: '豪华斗篷', cardType: 'trainer', trainerType: 'tool' } : { name: '卡' + id }),
      getInfo: () => null,
    };
    app._lastMainStatus = '';
    app._aiThinking = false;
    app.gs = {
      phase: 'MAIN', currentPlayer: null, log: [], winner: null,
      pendingPick: null, pendingPokemonPick: null, pendingBenchPromotion: null,
      player1: { name: '我方', active: p1Mon, bench: [], hand: [], deck: [], discard: [], prizes: [1, 2, 3, 4, 5, 6], energyAttached: false },
      player2: { name: '对手', active: p2Mon, bench: [], hand: [], deck: [], discard: [], prizes: [1, 2, 3, 4, 5, 6] },
    };
    app.gs.currentPlayer = app.gs.player1;
    return app;
  };

  // ---------- ④ 战斗区：道具方图标在能量前面 ----------
  {
    const app = build(mon({ tool }), mon({ tool: null }));
    app._renderMon(app.gs.player1.active, 'pl');
    const el = document.getElementById('pl-energy');
    const html = el.innerHTML;
    ok('④ 道具渲染为方形 .tool-chip（不是 .energy）', html.includes('class="tool-chip"') && !/class="energy[^"]*"[^>]*style/.test(html), html.slice(0, 120));
    ok('④ 道具显示首字「豪」', /class="tool-chip"[^>]*>豪</.test(html), html.slice(0, 160));
    const posTool = html.indexOf('tool-chip'), posEnergy = html.indexOf('class="energy');
    ok('④ 道具在能量前面', posTool >= 0 && posEnergy > posTool, `tool=${posTool} energy=${posEnergy}`);
    const chipCount = (html.match(/class="energy /g) || []).length;
    ok('④ 能量图标数量不受影响（2）', chipCount === 2, 'count=' + chipCount);

    // 未装备道具 → 不显示
    const app2 = build(mon({ tool: null }), mon());
    app2._renderMon(app2.gs.player1.active, 'pl');
    const html2 = document.getElementById('pl-energy').innerHTML;
    ok('④ 未装备道具时不显示 tool-chip', !html2.includes('tool-chip'), html2.slice(0, 80));
  }

  // ---------- ① 场地列表：道具首字放能量前面 ----------
  {
    const app = build(mon({ tool }), mon({ tool }));
    app.gs.player1.bench = [mon({ name: '备战甲', tool: null })];
    app._pokeHasActions = () => true;
    app._showPokemonList();
    const items = [...document.querySelectorAll('#list-menu .menu-item .mv-meta')].map(e => e.textContent);
    ok('① 我方场地列表含「100/120·豪草火」', items.some(t => t === '100/120·豪草火'), JSON.stringify(items));
    const app2 = build(mon({ tool: null }), mon({ tool: null }));
    app2._pokeHasActions = () => true;
    app2._showPokemonList();
    const items2 = [...document.querySelectorAll('#list-menu .menu-item .mv-meta')].map(e => e.textContent);
    ok('① 未装备道具时不写入首字（仍是 100/120·草火）', items2.some(t => t === '100/120·草火'), JSON.stringify(items2));
  }

  // ---------- ③ 对方回合：卡牌 / 场地 置灰 ----------
  {
    const app = build(mon(), mon());
    app.gs.currentPlayer = app.gs.player2;      // 对手回合
    app._updateMainMenu();
    const items = [...document.querySelectorAll('#main-menu .menu-item')];
    const byAction = a => items.find(i => i.dataset.action === a);
    ok('③ 对手回合：卡牌置灰', byAction('cards').classList.contains('disabled'));
    ok('③ 对手回合：场地置灰', byAction('pokemon').classList.contains('disabled'));
    ok('③ 对手回合：战斗/结束置灰', byAction('fight').classList.contains('disabled') && byAction('end').classList.contains('disabled'));

    const app2 = build(mon(), mon());
    app2.gs.currentPlayer = app2.gs.player1;    // 我方回合
    app2._updateMainMenu();
    const items2 = [...document.querySelectorAll('#main-menu .menu-item')];
    const b2 = a => items2.find(i => i.dataset.action === a);
    ok('③ 我方回合：卡牌/场地可用（不误灰）', !b2('cards').classList.contains('disabled') && !b2('pokemon').classList.contains('disabled'));
  }

  // ---------- ② 昏厥后选择上场宝可梦 ----------
  {
    const app = build(mon({ name: '出战A' }), mon());
    app.gs.player1.bench = [mon({ name: '备战乙', energy: ['水能量'], tool: null }), mon({ name: '备战丙', tool: { cardId: 'T1', name: '英雄斗篷' } })];
    app.gs.pendingBenchPromotion = app.gs.player1;
    const shown = app._maybeShowBenchPromotion();
    ok('② 弹出上场选择', shown === true);
    const text = document.getElementById('list-text');
    ok('② 显示提示行且可见', !!text && !text.hidden && /请选择上场的宝可梦/.test(text.textContent), text ? text.textContent : '');
    const labels = [...document.querySelectorAll('#list-menu .menu-item .mv-name')].map(e => e.textContent);
    ok('② 列出保持 + 各备战选项', labels.length === 3 && /保持/.test(labels[0]) && /备战乙/.test(labels[1]) && /备战丙/.test(labels[2]), JSON.stringify(labels));
    ok('② 强制选择：没有「返回」项', !document.querySelector('#list-menu .back-item'));
    const metas = [...document.querySelectorAll('#list-menu .menu-item .mv-meta')].map(e => e.textContent);
    ok('② 选项里也带道具首字（英）', metas.some(t => t.includes('英')), JSON.stringify(metas));

    // 点击「换 备战乙 上场」→ 触发交换
    let swapped = null;
    app.gs.promoteBenchToActive = (pl, i) => { swapped = i; pl.active = pl.bench[i]; pl.bench[i] = { name: '出战A' }; pl.pendingBenchPromotion = null; return true; };
    app._renderScene = () => {};
    app._afterAction = () => {};
    document.querySelectorAll('#list-menu .menu-item')[1].click();
    ok('② 点击后调用 promoteBenchToActive(idx=0)', swapped === 0, 'idx=' + swapped);
    ok('② 交换后出战位变成所选宝可梦', app.gs.player1.active.name === '备战乙', app.gs.player1.active.name);
  }

  // ---------- _toolShort 边界 ----------
  {
    const app = build(mon(), mon());
    ok('_toolShort：无道具 → 空', app._toolShort(mon()) === '');
    ok('_toolShort：取首字', app._toolShort(mon({ tool })) === '豪');
    ok('_toolShort：name 缺失时回退到 resolver', app._toolShort(mon({ tool: { cardId: 'T1' } })) === '豪');
  }
  return results;
});

let pass = 0, fail = 0;
for (const r of out) {
  if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
  else { fail++; console.log('  ✗ ' + r.name + '   ' + (r.extra || '')); }
}
console.log(`\n=== DOM 验证：${pass} 通过 / ${fail} 失败 ===`);
if (errs.length) { console.log('=== 页面错误 ==='); errs.slice(0, 8).forEach(e => console.log('  ' + e)); }
else console.log('页面无 JS 错误 ✓');
await browser.close();
await done(fail ? 1 : 0);
