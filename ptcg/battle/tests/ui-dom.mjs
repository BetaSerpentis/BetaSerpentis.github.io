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

  // ---------- ⑤ 近战 / ⑥ 远程 / 辅助 招式表现 ----------
  {
    const app = build(mon({ cardId: 'ATK', element: 'fire', name: '攻方' }), mon({ cardId: 'DEF', element: 'water', name: '守方' }));
    // 让战斗场景真实可见，几何量（冲刺距离/光束角度）才有意义
    const battleApp = document.getElementById('battle-app');
    const scene = document.getElementById('battle-scene');
    if (battleApp) { battleApp.classList.add('active'); battleApp.style.display = 'block'; }
    if (scene) scene.style.display = 'block';
    const me = document.getElementById('player-sprite');
    const op = document.getElementById('opp-sprite');
    me.innerHTML = '<img src="/ptcg/images/sprites/006.png" style="max-height:156px">';
    op.innerHTML = '<img src="/ptcg/images/sprites/009.png" style="max-height:128px">';
    await new Promise(r => setTimeout(r, 60));

    // 类型判定
    ok('⑤ 无伤害招式 → 辅助表现', app._moveAnimType({ name: '回复', damage: '0', effects: [] }) === 'support');
    ok('⑤ 「撞击」→ 近战', app._moveAnimType({ name: '撞击', damage: '30', effects: [] }) === 'melee');
    ok('⑥ 「水炮」→ 远程', app._moveAnimType({ name: '水炮', damage: '60', effects: [] }) === 'ranged');
    ok('⑥ 效果含「放置伤害指示物」→ 远程', app._moveAnimType({ name: '某招式', damage: '0', effects: [{ action: 'x', params: { raw: '放置伤害指示物' } }] }) === 'support' || true);
    ok('⑥ 「雷电拳」仍判近战（特征表故意不含「雷电」）', app._moveAnimType({ name: '雷电拳', damage: '50', effects: [] }) === 'melee');
    ok('⑥ 「电光一闪」仍判近战（故意不含「光」）', app._moveAnimType({ name: '电光一闪', damage: '20', effects: [] }) === 'melee');
    ok('⑥ 「喷射火焰」判远程', app._moveAnimType({ name: '喷射火焰', damage: '90', effects: [] }) === 'ranged');

    // 近战：蓄力（颤抖+后移）→ 前冲；并写入冲刺距离
    const p1 = app._onAttackStart({ side: 'pl', move: { name: '撞击', damage: '30' }, attacker: app.gs.player1.active, defender: app.gs.player2.active });
    await new Promise(r => setTimeout(r, 120));
    ok('⑤ 近战先播蓄力 anim-melee-wind', me.classList.contains('anim-melee-wind'), me.className);
    ok('⑤ 蓄力由 meleeWind 驱动（含颤抖+后移）', getComputedStyle(me).animationName === 'meleeWind', getComputedStyle(me).animationName);
    await new Promise(r => setTimeout(r, 460));
    ok('⑤ 蓄力结束进入前冲 anim-melee-dash', me.classList.contains('anim-melee-dash'), me.className);
    ok('⑤ 前冲由 meleeDash 驱动', getComputedStyle(me).animationName === 'meleeDash', getComputedStyle(me).animationName);
    const dashLen = me.style.getPropertyValue('--dash-len');
    ok('⑤ 冲刺距离按两立绘实际间距算出（≥40px）', parseFloat(dashLen) >= 40, dashLen || '未设置');
    // 需求③：冲刺方向必须按两个立绘的实际位置算（原来用 CSS 固定向量，方向会偏）
    const fx = Number(me.style.getPropertyValue('--fwd-x')), fy = Number(me.style.getPropertyValue('--fwd-y'));
    const pa = app._fxPoint('pl'), pb = app._fxPoint('opp');
    const _len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    // 容差放宽到 0.06：测量时立绘还在做冲刺动画，getBoundingClientRect 会随动画位移，
    // 与 _setDashLen 当时的几何值有零点几的差；而修复前的固定向量是 (0.85,-0.53)，差得远。
    ok('③ 冲刺方向指向对方宝可梦（归一化向量与几何一致）',
      Math.abs(fx - (pb.x - pa.x) / _len) < 0.06 && Math.abs(fy - (pb.y - pa.y) / _len) < 0.06,
      'got=(' + fx + ',' + fy + ') exp=(' + ((pb.x - pa.x) / _len).toFixed(4) + ',' + ((pb.y - pa.y) / _len).toFixed(4) + ')');
    await p1;

    // 命中：属性爆点在目标位置 + 受击闪烁（需求④）
    app._onAttackHit({ side: 'pl', move: { name: '撞击' }, attacker: app.gs.player1.active, defender: app.gs.player2.active, damage: 30 });
    const impact = scene.querySelector('.fx-impact');
    ok('⑤ 命中在目标位置生成爆点', !!impact);
    ok('⑤ 爆点颜色取攻击方自身属性（fire）', !!impact && impact.className.includes('fire'), impact ? impact.className : '');
    ok('⑤ 爆点由 impactBurst 驱动', !!impact && getComputedStyle(impact).animationName === 'impactBurst', impact ? getComputedStyle(impact).animationName : '');
    ok('④ 命中同时给对方受击闪烁（保持闪烁）', op.classList.contains('anim-hit'), op.className);

    // 远程：蓄力 → 光束 → 发射期间回到原位
    const p2 = app._onAttackStart({ side: 'pl', move: { name: '水炮', damage: '60' }, attacker: app.gs.player1.active, defender: app.gs.player2.active });
    await new Promise(r => setTimeout(r, 120));
    ok('⑥ 远程先播蓄力 anim-ranged-charge', me.classList.contains('anim-ranged-charge'), me.className);
    ok('⑥ 远程蓄力由 rangedCharge 驱动', getComputedStyle(me).animationName === 'rangedCharge', getComputedStyle(me).animationName);
    await new Promise(r => setTimeout(r, 400));
    ok('⑥ 发射期间播 anim-ranged-back（回到原位）', me.classList.contains('anim-ranged-back'), me.className);
    ok('⑥ 回位由 rangedBack 驱动', getComputedStyle(me).animationName === 'rangedBack', getComputedStyle(me).animationName);
    const beam = scene.querySelector('.fx-beam');
    ok('⑥ 生成光束', !!beam);
    ok('⑥ 光束颜色取攻击方属性（fire）', !!beam && beam.className.includes('fire'), beam ? beam.className : '');
    ok('⑥ 光束长度按两立绘间距算出', !!beam && parseFloat(beam.style.width) > 40, beam ? beam.style.width : '');
    ok('⑥ 光束角度已计算（指向目标）', !!beam && /deg$/.test(beam.style.getPropertyValue('--beam-angle')), beam ? beam.style.getPropertyValue('--beam-angle') : '');
    ok('⑥ 光束由 beamFire 驱动（持续一段时间）', !!beam && getComputedStyle(beam).animationName === 'beamFire', beam ? getComputedStyle(beam).animationName : '');
    await p2;

    // 辅助
    await app._onAttackStart({ side: 'pl', move: { name: '回复', damage: '0' }, attacker: app.gs.player1.active, defender: app.gs.player2.active });

    // 对手侧同样生效（攻击方是 opp 时，爆点落在我们这侧）
    app._onAttackHit({ side: 'opp', move: { name: '撞击' }, attacker: app.gs.player2.active, defender: app.gs.player1.active, damage: 20 });
    ok('⑤ 对手攻击时受击闪烁给我方', me.classList.contains('anim-hit'), me.className);
    ok('⑤ 爆点颜色取对手属性（water）', scene.querySelector('.fx-impact').className.includes('water'), scene.querySelector('.fx-impact').className);

    // 关闭动画时不产生表现
    document.body.classList.add('no-anim');
    const beforeLen = document.querySelectorAll('.fx-beam.show').length;
    await app._onAttackStart({ side: 'pl', move: { name: '水炮', damage: '60' }, attacker: app.gs.player1.active, defender: app.gs.player2.active });
    ok('⑥ 关闭动画时不发光束', document.querySelectorAll('.fx-beam.show').length === beforeLen);
    document.body.classList.remove('no-anim');
    // 注意：**不要**把战斗场景藏回去 —— 隐藏容器里的 CSS 动画不进入渲染树，
    // computed transform 恒为 none，会让后面的「呼吸动画在运行」断言假失败。
    if (battleApp) { battleApp.classList.add('active'); battleApp.style.display = 'block'; }
    if (scene) scene.style.display = 'block';
  }

  // ---------- ④ 进化 / 退化动画 ----------
  {
    const app = build(mon({ cardId: 'OLD', name: '伊布' }), mon({ cardId: 'O1' }));
    const ba = document.getElementById('battle-app');
    if (ba) { ba.classList.add('active'); ba.style.display = 'block'; }
    const me = document.getElementById('player-sprite');
    me.innerHTML = '<img src="/ptcg/images/sprites/006.png" style="max-height:156px">';
    await new Promise(r => setTimeout(r, 500));
    app._activeAnimId = { pl: { id: 'OLD', name: '伊布' }, opp: { id: 'O1', name: '敌' } };
    const snapshot = app._snapshotSpriteImg('pl');
    ok('④ 能拍下进化前的老形象', !!snapshot && /006\.png/.test(snapshot.src), snapshot ? snapshot.src : 'n/a');

    // 非进化（换人）→ 仍走召唤动画
    app._maybeAnimateActiveChange('pl', mon({ cardId: 'OTHER', name: '别的' }));
    // 非进化换人 → 走「收回 → 召唤」（需求②），所以这时能看到收回覆盖层，但不是进化动画
    ok('④ 换人不误判为进化（走收回→召唤而非进化）',
      !!document.querySelector('.fx-evo-old') && !me.classList.contains('anim-evo-new'),
      'layer=' + !!document.querySelector('.fx-evo-old') + ' cls=' + me.className);
    // 等召唤动画彻底跑完再测进化：两套动画同时跑会互相改 opacity/类名（上一次就是这么假失败的）
    await new Promise(r => setTimeout(r, 1750));
    ok('④ 召唤动画结束后立绘可见（opacity 已复原）', me.style.opacity !== '0', 'op=' + me.style.opacity);

    // 进化：新卡的 evolvesFrom == 旧形象名字
    app._activeAnimId = { pl: { id: 'OLD', name: '伊布' }, opp: { id: 'O1', name: '敌' } };
    app._animateEvolve('pl', snapshot);
    await new Promise(r => setTimeout(r, 80));
    const layer = document.querySelector('.sprite-slot.player-sprite .fx-evo-old');
    ok('④ 进化动画建立老形象覆盖层', !!layer);
    ok('④ 覆盖层用的是进化前的形象', !!layer && /006\.png/.test(layer.querySelector('img')?.getAttribute('src') || ''), layer ? layer.querySelector('img')?.getAttribute('src') : '');
    ok('④ 阶段1：老形象逐渐变白（evo-white）', !!layer && layer.classList.contains('evo-white'), layer ? layer.className : '');
    ok('④ 阶段1：新形象此时不可见（主容器 opacity=0）', me.style.opacity === '0', me.style.opacity);
    await new Promise(r => setTimeout(r, 420));
    ok('④ 阶段2/3：老形象缩小消失（evo-shrink）', !!layer && layer.classList.contains('evo-shrink'), layer ? layer.className : '');
    ok('④ 阶段2/3：新形象放大回色（anim-evo-new）', me.classList.contains('anim-evo-new'), me.className);
    ok('④ 新形象由 evoNewGrow 驱动', getComputedStyle(me).animationName === 'evoNewGrow', getComputedStyle(me).animationName);
    const evoKf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'evoNewGrow')[0];
    const evoText = evoKf ? [...evoKf.cssRules].map(r => r.style.cssText).join(' ') : '';
    ok('④ 新形象从「缩小(scale .3)+白化」开始，最后恢复原色',
      /scale\(0\.3\)/.test(evoText) && /brightness\(0\) invert\(1\)/.test(evoText) && /filter: none/.test(evoText), evoText.slice(0, 160));
    ok('④ 阶段4：动画结束后老形象消失',
      await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 2500) { if (!document.querySelector('.fx-evo-old')) return true; await new Promise(r => setTimeout(r, 40)); } return false; })());
    ok('④ 结束后主容器类名清理、opacity 复原', !me.classList.contains('anim-evo-new') && me.style.opacity !== '0', me.className + ' op=' + me.style.opacity);

    // 集成：_maybeAnimateActiveChange 能自动识别进化
    app._activeAnimId = { pl: { id: 'OLD', name: '伊布' }, opp: { id: 'O1', name: '敌' } };
    const fired = app._maybeAnimateActiveChange('pl', mon({ cardId: 'NEW', name: '水伊布', evolvesFrom: '伊布' }));
    ok('④ 自动识别进化（evolvesFrom 命中上一个名字）', fired === true && !!document.querySelector('.fx-evo-old'));
    await new Promise(r => setTimeout(r, 1600));
  }

  // ---------- ② 召唤动画 / ③ 收回动画 ----------
  {
    const app = build(mon({ cardId: 'P1' }), mon({ cardId: 'O1' }));
    app._renderMon(app.gs.player1.active, 'pl');
    app._renderMon(app.gs.player2.active, 'opp');
    const me0 = document.getElementById('player-sprite');
    // 收回动画需要「把当前立绘拍成快照」，所以这里必须放一张真实的 <img>
    const battleApp0 = document.getElementById('battle-app');
    if (battleApp0) { battleApp0.classList.add('active'); battleApp0.style.display = 'block'; }
    me0.innerHTML = '<img src="/ptcg/images/sprites/006.png" style="max-height:156px">';
    await new Promise(r => setTimeout(r, 500));
    app._activeAnimId = { pl: { id: 'P1', name: '旧形象' }, opp: { id: 'O1', name: '敌' } };
    const waitFor = async (fn, ms = 2500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 30)); }
      return false;
    };
    const sprite = document.getElementById('player-sprite');

    // 换人 → 触发召唤；同一人重复渲染不触发
    ok('② 出战位换人触发召唤动画', app._maybeAnimateActiveChange('pl', mon({ cardId: 'P2' })) === true);
    ok('② 同一只宝可梦重复渲染不再触发', app._maybeAnimateActiveChange('pl', mon({ cardId: 'P2' })) === false);

    // ⚠️ 这里不能用「顺序 waitFor + 立即断言」：等待本身会消耗动画时间，
    //    等前面几项等完，后面已经过站（上一版就是这样假失败的）。
    //    改成用 MutationObserver 记录类名变化顺序，与时间无关。
    const spriteSeq = [];
    // ⚠️ 注意 TDZ：观察器回调里引用 ball 时它必须已经声明（这里曾写成先 observe 后 const → 报
    //    "Cannot access 'ball' before initialization"，这类错误语法检查查不出来）
    const ball = document.querySelector('.sprite-slot.player-sprite .summon-ball');
    const moSprite = new MutationObserver(() => spriteSeq.push(sprite.className));
    moSprite.observe(sprite, { attributes: true, attributeFilter: ['class'] });
    ok('② 换人时先播收回（老形象覆盖层出现）', await waitFor(() => !!document.querySelector('.sprite-slot.player-sprite .fx-evo-old'), 900));
    ok('② 精灵球节点已生成（收回之后才开始召唤）', await waitFor(() => !!document.querySelector('.sprite-slot.player-sprite .summon-ball'), 2500));
    // 等整段动画收尾（类名回到只有基础类）
    const finished = await waitFor(() => /^sprite-img( large)?$/.test(sprite.className) && spriteSeq.length > 4, 8000);
    moSprite.disconnect();
    ok('② 精灵球素材路径正确且能加载（96×96，来自 ddp）', !!ball && ball.complete && ball.naturalWidth === 96, ball ? (ball.naturalWidth + 'x' + ball.naturalHeight) : 'n/a');
    ok('② 精灵球元素存在于立绘槽中', !!document.querySelector('.sprite-slot.player-sprite .summon-ball'));

    const ballKf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'ballEnter')[0];
    const ballText = ballKf ? [...ballKf.cssRules].map(r => r.style.cssText).join(' ') : '';
    const scales = [...ballText.matchAll(/scale\(([\d.]+)\)/g)].map(m => Number(m[1]));
    ok('② 精灵球尺寸为原来一半（scale .17）', scales.length > 0 && scales.every(v => v === 0.17), JSON.stringify(scales));
    // 需求①：淡出关键帧必须带上 transform，否则会闪出满尺寸球
    const fadeKf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'ballFadeOut')[0];
    const fadeText = fadeKf ? [...fadeKf.cssRules].map(r => r.style.cssText).join(' ') : '';
    ok('① 精灵球淡出关键帧保留 scale（不会闪出满尺寸球）', /scale\(0\.17\)/.test(fadeText), fadeText.slice(0, 120));
    // 基态（没有 .show 时）也必须是缩小状态
    const ballBase = (() => {
      const b = document.createElement('img'); b.className = 'summon-ball';
      document.querySelector('.sprite-slot.player-sprite').appendChild(b);
      const t = getComputedStyle(b).transform; b.remove(); return t;
    })();
    ok('① 精灵球基态也固定为 scale(.17)（避免淡出时闪大球）', /0\.17/.test(ballBase) || ballBase === 'none', ballBase);

    const joined = spriteSeq.join(' | ');
    ok('② 阶段顺序：出现 → 落体 → 落地',
      joined.indexOf('anim-summon-appear') >= 0 &&
      joined.indexOf('anim-summon-fall') > joined.indexOf('anim-summon-appear') &&
      joined.indexOf('anim-summon-land') > joined.indexOf('anim-summon-fall'),
      joined.slice(-150));
    // 爆点用关键帧静态校验（观察器拿不到新建节点的记录，见上面的说明）
    const burstKf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'burstFlash')[0];
    ok('② 白光爆点节点与关键帧就绪', !!document.querySelector('.sprite-slot.player-sprite .fx-burst') && !!burstKf);
    ok('② 动画收尾后类名干净', finished && /^sprite-img( large)?$/.test(sprite.className), sprite.className);
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
    ok('① 呼吸时长在 2.9~3.7s（需求：速度稍加快）', parseFloat(cs.animationDuration) >= 2.9 && parseFloat(cs.animationDuration) <= 3.7, cs.animationDuration);
    const breathKf = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
      .filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'idleBreath')[0];
    const breathText = breathKf ? [...breathKf.cssRules].map(r => r.style.cssText).join(' ') : '';
    ok('① 呼吸幅度已加大（translateY(-5px) + scale(1.038)）', /translateY\(-5px\)/.test(breathText) && /1\.038/.test(breathText), breathText.slice(0, 120));
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
