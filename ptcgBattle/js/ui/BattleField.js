// js/ui/BattleField.js — Canvas 战斗场地渲染 (能量图标 + 点击)

import { pokemonSpriteSrc } from './SpriteUtils.js';

const COLORS = {
  panel:'#202830', panelBorder:'#405060', hpGreen:'#4c8', hpYellow:'#cc8', hpRed:'#e55',
  text:'#eee', textDim:'#99a'
};
const ENRG = { grass:'#4c8', fire:'#e55', water:'#38a', lightning:'#fc3', psychic:'#f58',
  fighting:'#c03028', dark:'#705848', metal:'#b8b8d0', dragon:'#7038f8', fairy:'#f06',
  colorless:'#aaa', 草:'#4c8',火:'#e55',水:'#38a',雷:'#fc3',超:'#f58',斗:'#c03028',
  恶:'#705848',钢:'#b8b8d0',龙:'#7038f8',妖:'#f06',无:'#aaa' };

export class BattleField {
  constructor(canvas, gs, resolver, cb={}) {
    this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.ctx.imageSmoothingEnabled=false;
    this.gs=gs; this.resolver=resolver; this.cb=cb;
    this.spriteCache={}; this.anim={active:false,t:0,type:null};
    this._hitAreas=[];
    this.resize();
    window.addEventListener('resize',()=>this.resize());
    this.canvas.addEventListener('click',e=>this._onClick(e));
  }

  getSprite(n){ if(!n)return null; const p=String(parseInt(n)).padStart(3,'0');
    if(!this.spriteCache[p]){ const i=new Image(); i.src=pokemonSpriteSrc(n); i.onerror=()=>{ i._missing=true; }; this.spriteCache[p]=i; }
    return this.spriteCache[p]; }

  resize(){ const p=this.canvas.parentElement; if(!p)return;
    this.canvas.width=p.clientWidth||600; this.canvas.height=p.clientHeight||400; this.draw(); }

  draw(){
    const ctx=this.ctx,W=this.canvas.width,H=this.canvas.height; this._hitAreas=[];
    this._bg(ctx,W,H);
    this._player(ctx,this.gs.player2,W*.05,H*.05,W*.9,H*.4,true);
    this._player(ctx,this.gs.player1,W*.05,H*.52,W*.9,H*.38,false);
    if(this.anim.active)this._overlay(ctx,W,H);
  }

  _bg(ctx,W,H){ ctx.fillStyle='#121820'; ctx.fillRect(0,0,W,H); }

  _player(ctx,pl,x,y,w,h,isOpp){
    const p=6; ctx.fillStyle=COLORS.panel; ctx.strokeStyle=COLORS.panelBorder; ctx.lineWidth=2;
    this._rr(ctx,x,y,w,h,6); ctx.fill(); ctx.stroke();
    const iw=w-p*2,ih=h-p*2;
    const actW=Math.min(iw*.28,ih*.7),actH=actW;
    const actX=x+p+iw*.38,actY=y+p+ih*.15;

    if(pl.active){ this._mon(ctx,pl.active,actX,actY,actW,actH,isOpp); }
    else { this._empty(ctx,actX,actY,actW,actH); }
    this._hitAreas.push({slot:'active',player:pl,x:actX,y:actY,w:actW,h:actH});

    // name
    ctx.fillStyle=COLORS.text; ctx.font='bold 12px sans-serif'; ctx.textAlign='center';
    ctx.fillText((pl.active?.name||'').slice(0,6),actX+actW/2,actY+actH+16);

    // bench
    const bw=Math.min(iw*.14,ih*.45),bh=bw,by=y+p+ih*.15,gap=bw+6;
    for(let i=0;i<5;i++){
      const bx=x+p+iw*.04+i*gap;
      if(i<pl.bench.length){ this._mon(ctx,pl.bench[i],bx,by,bw,bh,isOpp);
        ctx.fillStyle=COLORS.textDim; ctx.font='9px sans-serif'; ctx.textAlign='center';
        ctx.fillText((pl.bench[i].name||'').slice(0,4),bx+bw/2,by+bh+10);
      } else { this._empty(ctx,bx,by,bw,bh); }
      this._hitAreas.push({slot:'bench-'+i,player:pl,x:bx,y:by,w:bw,h:bh});
    }

    ctx.fillStyle=COLORS.text; ctx.font='bold 13px sans-serif'; ctx.textAlign='left';
    ctx.fillText(pl.name,x+p,y+16);
    this._stats(ctx,pl,x+w-110,y+p,105,50);
  }

  _mon(ctx,mon,x,y,w,h,isOpp){
    const info=this.resolver.getInfo(mon.cardId);
    ctx.fillStyle='#283040'; ctx.strokeStyle='#4a6070'; ctx.lineWidth=2;
    this._rr(ctx,x,y,w,h,4); ctx.fill(); ctx.stroke();

    if(info.number){const s=this.getSprite(info.number); if(s&&s.complete&&s.naturalWidth>0)
      {const m=w*.1; ctx.drawImage(s,x+m,y+m,w-m*2,h-m*2);}}

    // HP
    const bw=w*.85,bh=6,bx=x+(w-bw)/2,by2=y+h-bh-4;
    const r=Math.max(0,mon.hp/mon.maxHp);
    ctx.fillStyle='#1a1a28'; ctx.fillRect(bx,by2,bw,bh);
    ctx.fillStyle=r>.5?COLORS.hpGreen:(r>.2?COLORS.hpYellow:COLORS.hpRed);
    ctx.fillRect(bx,by2,bw*r,bh);
    ctx.fillStyle=COLORS.text; ctx.font=`bold ${Math.max(8,w*.11)}px sans-serif`; ctx.textAlign='center';
    ctx.fillText(`${mon.hp}/${mon.maxHp}`,x+w/2,y+h+bh+10);

    // 能量图标
    const eng=mon.energy||[];
    if(eng.length>0){
      const dot=Math.max(5,w*.08),dgap=dot+2;
      const dx=x+(w-(eng.length*(dgap)))/2;
      for(let i=0;i<eng.length;i++){
        const e=eng[i];
        const c=ENRG[this._findEle(e)]||'#aaa';
        ctx.fillStyle=c; ctx.beginPath(); ctx.arc(dx+i*dgap,y+h+bh+18,dot,0,Math.PI*2); ctx.fill();
      }
    }
  }

  _findEle(energy){
    const name = energy == null ? '' : (typeof energy === 'object' ? (energy.name || energy.cardName || energy.cardId || '') : String(energy));
    const keys=['草','火','水','雷','超','斗','恶','钢','龙','妖','无'];
    for(const k of keys){ if(name.includes(k))return k; }
    return '无';
  }

  _empty(ctx,x,y,w,h){ ctx.fillStyle='rgba(255,255,255,.04)'; this._rr(ctx,x,y,w,h,4); ctx.fill(); }

  _stats(ctx,pl,x,y,w,h){
    ctx.fillStyle='rgba(0,0,0,.5)'; this._rr(ctx,x,y,w,h,4); ctx.fill();
    ctx.fillStyle=COLORS.text; ctx.font='10px sans-serif'; ctx.textAlign='left';
    ctx.fillText(`牌库 ${pl.deck.length}`,x+6,y+13);
    ctx.fillText(`弃牌 ${pl.discard.length}`,x+6,y+26);
    ctx.fillText(`奖品 ${pl.prizes.length}/6`,x+6,y+39);
  }

  _overlay(ctx,W,H){ if(this.anim.type==='attack'){
    const a=.25*Math.sin(this.anim.t*4)+.25; ctx.fillStyle=`rgba(255,200,80,${a})`; ctx.fillRect(0,0,W,H); }}

  playAttackAnim(){ this.anim={active:true,t:0,type:'attack'}; this._runAnim(); }

  _runAnim(){ if(!this.anim.active)return; this.anim.t+=.04; this.draw();
    if(this.anim.t>1.5){this.anim.active=false;this.draw();return;} requestAnimationFrame(()=>this._runAnim()); }

  _onClick(e){
    const r=this.canvas.getBoundingClientRect();
    const mx=e.clientX-r.left, my=e.clientY-r.top;
    for(const area of this._hitAreas){
      if(mx>=area.x&&mx<=area.x+area.w&&my>=area.y&&my<=area.y+area.h){
        this.cb.onMonClick?.({slot:area.slot, player:area.player, isPlayer:area.player===this.gs.player1});
        return;
      }
    }
  }

  _rr(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);
    ctx.arcTo(x+w,y,x+w,y+r,r);ctx.lineTo(x+w,y+h-r);
    ctx.arcTo(x+w,y+h,x+w-r,y+h,r);ctx.lineTo(x+r,y+h);
    ctx.arcTo(x,y+h,x,y+h-r,r);ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.closePath(); }
}
