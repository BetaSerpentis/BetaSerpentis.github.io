// pencil.js — UI state machine for FRLG-style prototype

(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // Panels
  const panelMain = $('#panel-main');
  const panelFight = $('#panel-fight');
  const screenCards = $('#screen-cards');
  const screenPokemon = $('#screen-pokemon');

  function showPanel(panel) {
    $$('.dialog-panel').forEach(p => p.classList.remove('active'));
    panel.classList.add('active');
  }

  function showOverlay(screen) {
    screen.classList.add('active');
  }

  function hideOverlay(screen) {
    screen.classList.remove('active');
  }

  // Main menu actions
  panelMain.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const action = item.dataset.action;
    // Update cursor
    panelMain.querySelectorAll('.menu-item').forEach(i => {
      i.textContent = i.textContent.replace('▶', '　');
      i.classList.remove('selected');
    });
    item.textContent = item.textContent.replace('　', '▶');
    item.classList.add('selected');

    switch (action) {
      case 'fight': showPanel(panelFight); break;
      case 'cards': showOverlay(screenCards); break;
      case 'pokemon': showOverlay(screenPokemon); break;
      case 'end': flashMessage('回合结束！'); break;
    }
  });

  // Fight panel — back
  panelFight.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    if (item.classList.contains('back-item')) {
      showPanel(panelMain);
    } else if (!item.classList.contains('back-item')) {
      // Select move
      panelFight.querySelectorAll('.menu-item').forEach(i => {
        i.textContent = i.textContent.replace('▶', '　');
        i.classList.remove('selected');
      });
      item.textContent = item.textContent.replace('　', '▶');
      item.classList.add('selected');
    }
  });

  // Overlay — back buttons
  $$('.overlay-footer').forEach(footer => {
    footer.addEventListener('click', (e) => {
      if (e.target.classList.contains('right')) {
        hideOverlay(e.target.closest('.overlay-screen'));
      }
    });
  });

  // Card list selection
  $('.card-list').addEventListener('click', (e) => {
    const item = e.target.closest('.card-list-item');
    if (!item) return;
    $$('.card-list-item').forEach(i => {
      i.textContent = i.textContent.replace('▶', '　');
      i.classList.remove('selected');
    });
    item.textContent = item.textContent.replace('　', '▶');
    item.classList.add('selected');
  });

  // Page arrows (placeholder cycling)
  const pages = ['我方手牌', '我方弃牌区', '我方卡组', '我方奖赏卡', '对方手牌', '对方弃牌区', '对方卡组', '对方奖赏卡'];
  let cardPage = 0;
  screenCards.querySelector('.right').addEventListener('click', () => {
    cardPage = (cardPage + 1) % pages.length;
    screenCards.querySelector('.page-title').textContent = pages[cardPage];
    screenCards.querySelector('.page-indicator').textContent = `${cardPage + 1}/8`;
  });
  screenCards.querySelector('.left').addEventListener('click', () => {
    cardPage = (cardPage - 1 + pages.length) % pages.length;
    screenCards.querySelector('.page-title').textContent = pages[cardPage];
    screenCards.querySelector('.page-indicator').textContent = `${cardPage + 1}/8`;
  });

  const pokemonPages = ['我方宝可梦', '对方宝可梦'];
  let pokePage = 0;
  screenPokemon.querySelector('.right').addEventListener('click', () => {
    pokePage = (pokePage + 1) % 2;
    screenPokemon.querySelector('.page-title').textContent = pokemonPages[pokePage];
    screenPokemon.querySelector('.page-indicator').textContent = `${pokePage + 1}/2`;
  });
  screenPokemon.querySelector('.left').addEventListener('click', () => {
    pokePage = (pokePage - 1 + 2) % 2;
    screenPokemon.querySelector('.page-title').textContent = pokemonPages[pokePage];
    screenPokemon.querySelector('.page-indicator').textContent = `${pokePage + 1}/2`;
  });

  // Flash message helper
  function flashMessage(msg) {
    const text = panelMain.querySelector('.dialog-text');
    text.textContent = msg;
    setTimeout(() => { text.textContent = '皮卡丘想做什么？'; }, 1500);
  }

  // Responsive scaling
  function fitScreen() {
    const screen = $('#screen');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scaleX = vw / 480;
    const scaleY = vh / 320;
    const scale = Math.min(scaleX, scaleY);
    screen.style.transform = `scale(${scale})`;
  }
  window.addEventListener('resize', fitScreen);
  fitScreen();
})();
