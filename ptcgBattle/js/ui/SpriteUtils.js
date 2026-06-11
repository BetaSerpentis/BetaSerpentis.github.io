// js/ui/SpriteUtils.js — shared pokemon sprite URL/fallback helpers

export const SPRITE_BASE = '../ddp/images/';
export const SPRITE_IMG_ONERROR = "this.style.display='none';this.parentElement&&this.parentElement.classList.add('sprite-missing')";

export function pokemonSpriteSrc(number, base = SPRITE_BASE) {
  const parsed = parseInt(number, 10);
  if (!Number.isFinite(parsed)) return '';
  return `${base}${String(parsed).padStart(3, '0')}.png`;
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function pokemonSpriteImgHtml(number, alt = '') {
  const src = pokemonSpriteSrc(number);
  if (!src) return '';
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" onerror="${SPRITE_IMG_ONERROR}">`;
}
