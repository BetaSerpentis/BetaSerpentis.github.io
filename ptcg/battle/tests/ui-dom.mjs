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

  // ---------- ② 召唤动画 / ③ 收回动画 ----------
  {
    const app = build(mon({ cardId: 'P1' }), mon({ cardId: 'O1' }));
    app._renderMon(app.gs.player1.active, 'pl');
    app._renderMon(app.gs.player2.active, 'opp');
    app._activeAnimId = { pl: 'P1', opp: 'O1' };
    const waitFor = async (fn, ms = 2500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 30)); }
      return false;
    };
    const sprite = document.getElementById('player-sprite');

    // 换人 → 触发召唤；同一人重复渲染不触发
    ok('② 出战位换人触发召唤动画', app._maybeAnimateActiveChange('pl', mon({ cardId: 'P2' })) === true);
    ok('② 同一只宝可梦重复渲染不再触发', app._maybeAnimateActiveChange('pl', mon({ cardId: 'P2' })) === false);

    ok('② 精灵球节点已生成', await waitFor(() => !!document.querySelector('.sprite-slot.player-sprite .summon-ball'), 600));
    const ball = document.querySelector('.sprite-slot.player-sprite .summon-ball');
    ok('② 精灵球素材路径正确且能加载（96×96，来自 ddp）',
      await waitFor(() => ball && ball.complete && ball.naturalWidth === 96, 1500), ball ? (ball.naturalWidth + 'x' + ball.naturalHeight) : 'n/a');
    ok('② 精灵球正在旋转入场（.show）', !!ball && ball.classList.contains('show'));
    ok('② 精灵球带旋转关键帧 ballEnter', getComputedStyle(ball).animationName === 'ballEnter', getComputedStyle(ball).animationName);

    // 白光爆点
    const burst = document.querySelector('.sprite-slot.player-sprite .fx-burst');
    ok('② 白光爆点节点已生成', !!burst);
    ok('② 白光爆点触发（.show / burstFlash）',
      await waitFor(() => burst && (burst.classList.contains('show') || getComputedStyle(burst).animationName === 'burstFlash'), 1200));

    // 缩小白化出现 → 放大回色
    ok('② 宝可梦以缩小白化状态出现（anim-summon-appear）',
      await waitFor(() => sprite.classList.contains('anim-summon-appear'), 900));
    const csAppear = getComputedStyle(sprite);
    ok('② 出现阶段由 summonAppearGrow 驱动', csAppear.animationName === 'summonAppearGrow', csAppear.animationName);

    // 自由落体
    ok('② 随后进入自由落体（anim-summon-fall）',
      await waitFor(() => sprite.classList.contains('anim-summon-fall'), 900));
    ok('② 落体阶段由 summonFall 驱动', getComputedStyle(sprite).animationName === 'summonFall', getComputedStyle(sprite).animationName);

    // 落地震一下
    ok('② 落地震一下（anim-summon-land）',
      await waitFor(() => sprite.classList.contains('anim-summon-land'), 900));
    ok('② 落地阶段由 summonLand 驱动', getComputedStyle(sprite).animationName === 'summonLand', getComputedStyle(sprite).animationName);

    // 结束后清干净并恢复呼吸
    ok('② 动画结束后类名清理干净',
      await waitFor(() => !/anim-summon|anim-recall/.test(sprite.className), 1500), sprite.className);
    ok('② 结束后恢复呼吸动画', getComputedStyle(sprite).animationName === 'idleBreath', getComputedStyle(sprite).animationName);

    // ③ 收回：变白 → 缩小
    const recallP = app._animateRecall('pl');
    await new Promise(r => setTimeout(r, 80));
    ok('③ 收回动画已应用（anim-recall）', sprite.classList.contains('anim-recall'), sprite.className);
    ok('③ 收回由 recallOut 驱动', getComputedStyle(sprite).animationName === 'recallOut', getComputedStyle(sprite).animationName);
    const kf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'recallOut')[0];
    const kfText = kf ? [...kf.cssRules].map(r => r.keyText + ':' + r.style.cssText).join(' | ') : '';
    ok('③ 先变白（brightness(0) invert(1)）再缩小（scale 很小）',
      /brightness\(0\) invert\(1\)/.test(kfText) && /scale\(0\.0[0-9]/.test(kfText), kfText.slice(0, 160));
    await recallP;
    ok('③ 收回结束后类名清理', !sprite.classList.contains('anim-recall'));
  }

  // ---------- ① 休息（呼吸）动画 ----------
  {
    const app = build(mon({ cardId: 'PID-A' }), mon({ cardId: 'PID-B' }));
    app._renderMon(app.gs.player1.active, 'pl');
    app._renderMon(app.gs.player2.active, 'opp');
    const el = document.getElementById('player-sprite');
    const cs = getComputedStyle(el);
    ok('① 立绘容器默认播放 idleBreath', cs.animationName === 'idleBreath', cs.animationName);
    ok('① 呼吸时长在 3.8~4.8s（缓慢）', parseFloat(cs.animationDuration) >= 3.8 && parseFloat(cs.animationDuration) <= 4.8, cs.animationDuration);
    ok('① 用负延迟错开相位（双方不同步）', parseFloat(cs.animationDelay) <= 0, cs.animationDelay);
    const durA = el.style.getPropertyValue('--breath-dur');
    const durB = document.getElementById('opp-sprite').style.getPropertyValue('--breath-dur');
    ok('① 不同宝可梦呼吸参数不同（程序化变化）', durA && durB && durA !== durB, durA + ' vs ' + durB);
    // 同一只宝可梦重复渲染 → 参数稳定（不抖动）
    app._renderMon(app.gs.player1.active, 'pl');
    ok('① 同一宝可梦重复渲染参数稳定', el.style.getPropertyValue('--breath-dur') === durA);

    // 攻击动画类应接管 animation，移除后恢复呼吸
    el.classList.add('anim-attack');
    const csAtk = getComputedStyle(el);
    ok('① anim-attack 时由 lunge 接管（呼吸让位）', csAtk.animationName === 'lunge-pl', csAtk.animationName);
    el.classList.remove('anim-attack');
    ok('① 动画类移除后恢复呼吸', getComputedStyle(el).animationName === 'idleBreath');

    // 全局关闭动画
    document.body.classList.add('no-anim');
    ok('① body.no-anim 时呼吸停止', getComputedStyle(el).animationName === 'none', getComputedStyle(el).animationName);
    document.body.classList.remove('no-anim');

    // 客观证据：间隔取两帧，像素必须变化（动画确实在跑）
    const frame = () => {
      const r = el.getBoundingClientRect();
      return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res({
        t: performance.now(),
        m: getComputedStyle(el).transform,
        x: Math.round(r.width * 100), y: Math.round(r.height * 100),
      }))));
    };
    const f1 = await frame();
    await new Promise(r => setTimeout(r, 1100));
    const f2 = await frame();
    ok('① 1.1s 后 transform 发生变化（动画在运行）', f1.m !== f2.m, f1.m + ' -> ' + f2.m);
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
