// ptcg/js/ui/SetFilterManager.js
export class SetFilterManager {
    constructor(cardManager, cardGrid) {
        this.cardManager = cardManager;
        this.cardGrid = cardGrid;
        this.sets = [];            // [{code, name, series, date}]
        this.currentSet = 'all';  // 'all' or set_code
        this.overlay = null;
        this._loaded = false;
    }

    // Load sets list from TSV
    async loadSets() {
        if (this._loaded) return this.sets;
        try {
            const resp = await fetch('data_fast/sets.tsv');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            const lines = text.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
            // Skip header
            for (let i = 1; i < lines.length; i++) {
                const f = lines[i].split('\t');
                if (f.length >= 4 && f[0]) {
                    this.sets.push({
                        code: f[0],
                        name: f[1] || f[0],
                        series: f[2] || '',
                        date: f[3] || ''
                    });
                }
            }
            this._loaded = true;
        } catch (e) {
            console.error('加载卡包列表失败:', e);
        }
        return this.sets;
    }

    // Get current set code
    getCurrentSet() {
        return this.currentSet;
    }

    // Select a set and apply filter
    selectSet(setCode) {
        this.currentSet = setCode || 'all';
        this.applySetFilter();
        this._closeOverlay();
    }

    // Apply set filter to cardManager
    applySetFilter() {
        // Sync SetFilterManager state → CardManager
        this.cardManager.currentSetCode = this.currentSet;
        this.cardManager.isSetFiltered = this.currentSet !== 'all';
        // Ensure getDisplayCards flows through the right path
        this.cardManager.isShowingAllCards = true;
        this.cardManager.hasActiveSearch = false;

        this.cardGrid.render();
        this._updateSetIndicator();
    }

    _updateSetIndicator() {
        let old = document.getElementById('set-indicator');
        if (old) old.remove();
        if (this.currentSet === 'all') return;

        const si = document.createElement('div');
        si.id = 'set-indicator';
        const s = this.sets.find(x => x.code === this.currentSet);
        si.textContent = '卡包：' + (s ? s.name : this.currentSet);
        si.style.cssText = 'text-align:center;color:#a0a0b0;font-size:0.85rem;padding:4px 0;';
        const grid = document.getElementById('card-grid');
        if (grid) grid.parentNode.insertBefore(si, grid);
    }

    // Show the set selection popup
    async showSetList() {
        await this.loadSets();
        this._closeOverlay();

        // Backdrop
        const bd = document.createElement('div');
        bd.className = 'set-list-backdrop';
        bd.addEventListener('click', () => this._closeOverlay());
        document.body.appendChild(bd);

        // Panel
        const panel = document.createElement('div');
        panel.className = 'set-list-panel';

        // Header
        const title = document.createElement('div');
        title.className = 'set-list-title';
        title.textContent = '选择卡包';
        panel.appendChild(title);

        // List container
        const list = document.createElement('div');
        list.className = 'set-list-scroll';

        // "全部" option
        const allItem = document.createElement('div');
        allItem.className = 'set-list-item' + (this.currentSet === 'all' ? ' active' : '');
        allItem.textContent = '全部 (查看所有卡牌)';
        allItem.addEventListener('click', () => this.selectSet('all'));
        list.appendChild(allItem);

        // Set items
        let lastSeries = '';
        for (const s of this.sets) {
            if (s.series !== lastSeries) {
                lastSeries = s.series;
                const sep = document.createElement('div');
                sep.className = 'set-list-series';
                sep.textContent = s.series;
                list.appendChild(sep);
            }
            const item = document.createElement('div');
            item.className = 'set-list-item' + (this.currentSet === s.code ? ' active' : '');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'set-list-item-name';
            nameSpan.textContent = s.name;
            const dateSpan = document.createElement('span');
            dateSpan.className = 'set-list-item-date';
            dateSpan.textContent = s.date;
            item.appendChild(nameSpan);
            item.appendChild(dateSpan);
            item.addEventListener('click', () => this.selectSet(s.code));
            list.appendChild(item);
        }

        panel.appendChild(list);
        document.body.appendChild(panel);

        // Animate in
        requestAnimationFrame(() => {
            bd.classList.add('visible');
            panel.classList.add('visible');
        });

        this.overlay = { backdrop: bd, panel };
    }

    _closeOverlay() {
        if (!this.overlay) return;
        const { backdrop, panel } = this.overlay;
        backdrop.classList.remove('visible');
        panel.classList.remove('visible');
        setTimeout(() => {
            backdrop.remove();
            panel.remove();
        }, 250);
        this.overlay = null;
    }

    // Reset to "全部"
    reset() {
        this.currentSet = 'all';
        this.cardManager.resetSetFilter();
        const old = document.getElementById('set-indicator');
        if (old) old.remove();
    }
}
