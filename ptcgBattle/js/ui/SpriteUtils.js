// js/ui/SpriteUtils.js — 宝可梦立绘 / 卡图 资源路径与回退链
//
// 资源策略（与 UI-MIGRATION-PLAN.md 对齐）：
//   1) 在线优先（PokeAPI sprites，与 pmBattle 同源）
//   2) 本地回退（../ddp/images/NNN.png，离线可用）
//   3) 再失败 → 隐藏 img 并给容器加 .sprite-missing（显示文字占位）
// 未来改为「纯本地资源运行」时：把本地目录补齐后，把 SPRITE_PREFER_ONLINE 置 false，
// 或把 onlineSpr teBase 指向本地目录（sprite/），调用方无需改动。

export const SPRITE_BASE = '../ddp/images/';
export const SPRITE_ONLINE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
export const SPRITE_IMG_ONERROR = "this.style.display='none';this.parentElement&&this.parentElement.classList.add('sprite-missing')";

// 是否默认在线优先（main.js 渲染时传 { preferOnline: true } 覆盖此值）
export let SPRITE_PREFER_ONLINE = true;

export function setSpritePreferOnline(v) { SPRITE_PREFER_ONLINE = !!v; }

/** 本地精灵图（ddp/images/NNN.png）——历史行为保持不变 */
export function pokemonSpriteSrc(number, base = SPRITE_BASE) {
  const parsed = parseInt(number, 10);
  if (!Number.isFinite(parsed)) return '';
  return `${base}${String(parsed).padStart(3, '0')}.png`;
}

/** 在线精灵图（PokeAPI）；back=true 为我方背面形象 */
export function pokemonSpriteOnlineSrc(number, back = false) {
  const parsed = parseInt(number, 10);
  if (!Number.isFinite(parsed)) return '';
  return `${SPRITE_ONLINE_BASE}${back ? 'back/' : ''}${parsed}.png`;
}

/** 立绘候选链：按在线优先/本地优先给出依次尝试的 URL */
export function pokemonSpriteCandidates(number, { back = false, preferOnline = SPRITE_PREFER_ONLINE } = {}) {
  const online = pokemonSpriteOnlineSrc(number, back);
  const onlineFront = pokemonSpriteOnlineSrc(number, false);
  const local = pokemonSpriteSrc(number);
  if (!online) return [];
  const chain = preferOnline
    ? [online, back ? onlineFront : null, local]
    : [local, online];
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
 * 默认（无 opts）保持历史行为：src=本地 ddp 图 + onerror 隐藏（兼容既有测试与调用方）。
 * opts.preferOnline=true 时：src=在线图，data-fb=后续回退链（在线正面 → 本地 → 隐藏）。
 */
export function pokemonSpriteImgHtml(number, alt = '', opts = {}) {
  // 未显式给出 preferOnline 时保持历史行为：本地图 + 直接隐藏回退（兼容既有调用方与测试）
  if (!Object.prototype.hasOwnProperty.call(opts, 'preferOnline')) {
    const local = pokemonSpriteSrc(number);
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
//  卡图（真实卡面 webp，来自 ptcg/images）
//  规则：set-code ID（如 CSV6C-099）→ images/CSV6C/099.webp 与 .thumb.webp
//        旧数字 ID（如 4521）      → images/hk00004521.webp
//  体积较大，一律使用缩略图；详情页才用大图。
// ============================================================
export const CARD_IMAGE_BASE = '../ptcg/images/';

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
