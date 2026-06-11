// js/ui/CardPicker.js — 卡牌选择弹窗

import { pokemonSpriteSrc } from './SpriteUtils.js';

export class CardPicker {
  constructor(resolver) {
    this.resolver=resolver;this._resolve=null;this._createDOM();
  }

  _createDOM(){
    this.overlay=document.createElement('div');
    this.overlay.className='picker-overlay';
    this.overlay.innerHTML=`<div class="picker-box"><div class="picker-title">选择卡牌</div>
      <div class="picker-grid" id="picker-grid"></div>
      <div class="picker-actions"><button class="picker-btn picker-cancel">取消</button>
      <button class="picker-btn picker-confirm">确认</button></div></div>`;
    document.body.appendChild(this.overlay);
    this.grid=this.overlay.querySelector('#picker-grid');
    this.overlay.querySelector('.picker-cancel').addEventListener('click',()=>this._close([]));
    this.overlay.querySelector('.picker-confirm').addEventListener('click',()=>{
      const sel=[...this.grid.querySelectorAll('.picker-card.selected')].map(el=>el.dataset.index);
      this._close(sel);
    });
    this.overlay.addEventListener('click',e=>{if(e.target===this.overlay)this._close([]);});
  }

  show(cardIds,max=1){
    this.overlay.style.display='flex';this.grid.innerHTML='';
    const maxSel=Math.min(max,cardIds.length);
    cardIds.forEach((cid,i)=>{
      const info=this.resolver.getInfo(cid),num=info.number;
      const div=document.createElement('div');div.className='picker-card';div.dataset.index=i;
      if(num){const img=document.createElement('img');
        img.src=pokemonSpriteSrc(num);img.onerror=()=>{img.style.display='none';};div.appendChild(img);}
      const name=document.createElement('span');name.textContent=info.name;div.appendChild(name);
      div.addEventListener('click',()=>{
        if(div.classList.contains('selected'))div.classList.remove('selected');
        else if(this.grid.querySelectorAll('.picker-card.selected').length<maxSel)div.classList.add('selected');
      });
      this.grid.appendChild(div);
    });
    return new Promise(r=>{this._resolve=r;});
  }

  _close(selected){this.overlay.style.display='none';if(this._resolve){this._resolve(selected);this._resolve=null;}}
}
