// js/ui/SpriteUtils.js — 宝可梦立绘 / 卡图 资源路径与回退链
//
// 资源策略：
//   1) **本地优先**：/ptcg/images/sprites/NNN.png（正面）/ sprites/back/NNN.png（背面，我方）
//   2) 在线回退：PokeAPI sprites（与 pmBattle 同源）
//   3) 再失败 → 隐藏 img 并给容器加 .sprite-missing（显示文字占位）
//
// 2026-09 变更：立绘已全部本地化（1018 个图鉴号 × 正/背 = 2036 张，约 1.9 MB，
// 由 ptcg/tools/fetch-battle-sprites.py 生成），因此默认改为本地优先、不再依赖网络。
// 注意：不要复用 /ddp/images/ —— 那里是 ddp 子项目的 256×64 像素风 4 帧切片，
// 与这里的 96×96 官方风立绘不是同一套美术，混用会出现画风突变。

export const SPRITE_BASE = '/ptcg/images/sprites/';
export const SPRITE_ONLINE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
export const SPRITE_IMG_ONERROR = "this.style.display='none';this.parentElement&&this.parentElement.classList.add('sprite-missing')";

// 是否在线优先。本地已补齐 → 默认 false（本地优先，在线作为回退）。
// 调用方应传 { preferOnline: SPRITE_PREFER_ONLINE } 而不是硬编码 true，
// 这样以后要切回在线只需要改这一个开关。
export let SPRITE_PREFER_ONLINE = false;

export function setSpritePreferOnline(v) { SPRITE_PREFER_ONLINE = !!v; }

/**
 * 本地精灵图：正面 base/NNN.png / 背面 base/back/NNN.png（我方用背面）
 * 注意补零规则是 padStart(3,'0')：1 → 001.png，1000 → 1000.png
 */
export function pokemonSpriteSrc(number, base = SPRITE_BASE, { back = false } = {}) {
  const parsed = parseInt(number, 10);
  if (!Number.isFinite(parsed)) return '';
  return `${base}${back ? 'back/' : ''}${String(parsed).padStart(3, '0')}.png`;
}

/** 在线精灵图（PokeAPI）；back=true 为我方背面形象 */
export function pokemonSpriteOnlineSrc(number, back = false) {
  const parsed = parseInt(number, 10);
  if (!Number.isFinite(parsed)) return '';
  return `${SPRITE_ONLINE_BASE}${back ? 'back/' : ''}${parsed}.png`;
}

/**
 * 立绘候选链：按在线优先/本地优先给出依次尝试的 URL。
 * 两侧都按「需要的那一面 → 正面」回退（背面图缺失时至少还能显示正面，不至于空着）。
 */
export function pokemonSpriteCandidates(number, { back = false, preferOnline = SPRITE_PREFER_ONLINE } = {}) {
  const online = pokemonSpriteOnlineSrc(number, back);
  const onlineFront = back ? pokemonSpriteOnlineSrc(number, false) : null;
  const local = pokemonSpriteSrc(number, SPRITE_BASE, { back });
  const localFront = back ? pokemonSpriteSrc(number, SPRITE_BASE, { back: false }) : null;
  if (!online && !local) return [];
  const chain = preferOnline
    ? [online, onlineFront, local, localFront]
    : [local, localFront, online, onlineFront];
  return chain.filter(Boolean);
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 浏览器端回退处理器：按 data-fb 链依次尝试，链耗尽后隐藏并标记缺失
if (typeof window !== 'undefined' && !window.__spriteFallback) {
  window.__spriteFallback = function (img) {
    const list = String(img.dataset.fb || '').split('|').filter(Boolean);
    if (!list.length) {
      img.style.display = 'none';
      if (img.parentElement) img.parentElement.classList.add('sprite-missing');
      return;
    }
    img.dataset.fb = list.slice(1).join('|');
    img.src = list[0];
  };
}

/**
 * 立绘 <img> HTML。
 * 默认（无 opts）保持历史行为：src=本地图 + onerror 隐藏（兼容既有测试与调用方）。
 * 显式给出 opts.preferOnline 时：按候选链设置 src + data-fb（依次回退）。
 */
export function pokemonSpriteImgHtml(number, alt = '', opts = {}) {
  // 未显式给出 preferOnline 时保持历史行为：本地图 + 直接隐藏回退（兼容既有调用方与测试）
  if (!Object.prototype.hasOwnProperty.call(opts, 'preferOnline')) {
    const local = pokemonSpriteSrc(number, SPRITE_BASE, { back: !!opts.back });
    if (!local) return '';
    return `<img src="${escapeAttr(local)}" alt="${escapeAttr(alt)}" onerror="${SPRITE_IMG_ONERROR}">`;
  }
  const chain = pokemonSpriteCandidates(number, opts);
  if (!chain.length) return '';
  const src = chain[0];
  const rest = chain.slice(1);
  return `<img src="${escapeAttr(src)}" data-fb="${escapeAttr(rest.join('|'))}" alt="${escapeAttr(alt)}" onerror="window.__spriteFallback&&window.__spriteFallback(this)">`;
}


// ============================================================
//  立绘底部透明留白测量（需求：让宝可梦的脚真正踩在脚踏台上）
//  不同宝可梦 PNG 的底部留白差异很大（实测 8%~23%+，鱼形/云朵形更大），
//  用统一的负 margin 无法兼顾，这里按图片实际内容底边计算补偿量。
//  说明：用离屏 Image + crossOrigin 读取像素，跨域失败时返回 0（回退到 CSS 默认值）。
// ============================================================
const _spriteTrimCache = new Map();

export function spriteBottomPadRatio(url) {
  if (!url) return Promise.resolve(0);
  if (_spriteTrimCache.has(url)) return _spriteTrimCache.get(url);
  const task = new Promise(resolve => {
    try {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = i.naturalWidth; c.height = i.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(i, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let bottom = -1;
          for (let y = c.height - 1; y >= 0 && bottom < 0; y--) {
            for (let x = 0; x < c.width; x++) {
              if (d[(y * c.width + x) * 4 + 3] > 8) { bottom = y; break; }
            }
          }
          resolve(bottom < 0 ? 0 : (c.height - 1 - bottom) / c.height);
        } catch (e) { resolve(0); }
      };
      i.onerror = () => resolve(0);
      i.src = url;
    } catch (e) { resolve(0); }
  });
  _spriteTrimCache.set(url, task);
  return task;
}

// 把立绘的底部留白裁掉：按显示高度换算成负 margin
export function applySpriteBottomTrim(img) {
  if (!img || !img.src) return;
  spriteBottomPadRatio(img.src).then(ratio => {
    if (!ratio || ratio <= 0.01) return;
    const shown = img.getBoundingClientRect().height || img.naturalHeight || 0;
    if (!shown) return;
    // 留一点余量（乘 0.9），避免把贴地的宝可梦压进台子里
    img.style.marginBottom = `${-Math.round(ratio * shown * 0.9)}px`;
  }).catch(() => { /* ignore */ });
}

// ============================================================
//  卡图（真实卡面 webp，来自 ptcg/images）
//  规则：set-code ID（如 CSV6C-099）→ /ptcg/images/CSV6C/099.webp 与 .thumb.webp
//        旧数字 ID（如 4521）      → /ptcg/images/hk00004521.webp
//  体积较大，一律使用缩略图；详情页才用大图。
// ============================================================
export const CARD_IMAGE_BASE = '/ptcg/images/';

export function cardImagePaths(cardId, base = CARD_IMAGE_BASE) {
  const str = String(cardId ?? '');
  if (!str) return { thumb: '', full: '' };
  if (str.includes('-')) {
    const [setCode, cardIndex] = str.split('-');
    if (!setCode || !cardIndex) return { thumb: '', full: '' };
    return { thumb: `${base}${setCode}/${cardIndex}.thumb.webp`, full: `${base}${setCode}/${cardIndex}.webp` };
  }
  const padded = str.padStart(8, '0');
  return { thumb: `${base}hk${padded}.webp`, full: `${base}hk${padded}.webp` };
}

export function cardThumbSrc(cardId, base = CARD_IMAGE_BASE) {
  return cardImagePaths(cardId, base).thumb;
}

export function cardFullSrc(cardId, base = CARD_IMAGE_BASE) {
  return cardImagePaths(cardId, base).full;
}

/** 卡面缩略图 <img>（失败自动隐藏，保底仍有名字/标签） */
export function cardThumbImgHtml(cardId, alt = '') {
  const src = cardThumbSrc(cardId);
  if (!src) return '';
  return `<img class="card-art" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" onerror="${SPRITE_IMG_ONERROR}">`;
}

export function cardFullImgHtml(cardId, alt = '') {
  const src = cardFullSrc(cardId);
  if (!src) return '';
  return `<img class="card-art-full" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" onerror="window.__cardArtFallback&&window.__cardArtFallback(this)">`;
}

// 大卡图加载失败：隐藏图片并显示同容器内的 .card-art-fallback 文字占位
if (typeof window !== 'undefined' && !window.__cardArtFallback) {
  window.__cardArtFallback = function (img) {
    img.style.display = 'none';
    const sib = img.nextElementSibling;
    if (sib && sib.classList && sib.classList.contains('card-art-fallback')) sib.hidden = false;
    if (img.parentElement) img.parentElement.classList.add('card-art-missing');
  };
}

/** 本地缓存预热（可选）：把在线立绘放进 Cache Storage，离线时仍可用 */
export async function warmSpriteCache(numbers) {
  if (typeof caches === 'undefined' || typeof fetch === 'undefined') return 0;
  const list = (Array.isArray(numbers) ? numbers : [numbers])
    .map(n => parseInt(n, 10))
    .filter(Number.isFinite);
  if (!list.length) return 0;
  let cached = 0;
  try {
    const cache = await caches.open('ptcg-sprites-v1');
    for (const n of list.slice(0, 60)) {
      for (const back of [false, true]) {
        const url = pokemonSpriteOnlineSrc(n, back);
        if (!url) continue;
        const hit = await cache.match(url);
        if (hit) continue;
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res && res.ok) { await cache.put(url, res.clone()); cached++; }
        } catch (e) { /* 离线或跨域，忽略 */ }
      }
    }
  } catch (e) { /* Cache API 不可用，忽略 */ }
  return cached;
}
