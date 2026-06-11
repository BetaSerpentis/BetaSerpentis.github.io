export class TsvCardDataLoader {
    constructor({ generateImage }) {
        this.generateImage = generateImage;
    }

    async loadIndex(config, cardType) {
        const rows = await this.fetchCompactRows(config.idxFile, 'idx1');
        const cards = rows.map(values => {
            const [id, name, number, attribute, quantity, equivalenceKey] = values;
            return {
                id,
                name: name || '未知',
                type: cardType,
                number: number || '未知',
                attribute: attribute || '未知',
                quantity: parseInt(quantity, 10) || 0,
                equivalenceKey: equivalenceKey || '',
                image: this.generateImage(id)
            };
        });

        return cards;
    }

    async loadSearch(config) {
        if (!config.searchFile) return new Map();
        const rows = await this.fetchCompactRows(config.searchFile, 'srch1');
        return new Map(rows.map(([id, searchText]) => [id, searchText || '']));
    }

    async loadFilter(config) {
        if (!config.filterFile) return new Map();
        const rows = await this.fetchCompactRows(config.filterFile, 'flt1');
        return new Map(rows.map(values => {
            const [id, hp, stage, attr, retreat, flags, costs, dmg] = values;
            return [id, {
                hp: this.parseOptionalNumber(hp),
                stage: this.parseOptionalNumber(stage),
                attr: attr || '',
                retreat: this.parseOptionalNumber(retreat),
                flags: parseInt(flags || '0', 16) || 0,
                costs: costs || '',
                dmg: dmg || ''
            }];
        }));
    }

    async loadCardType(config, cardType) {
        const [cards, searchMap, filterMap] = await Promise.all([
            this.loadIndex(config, cardType),
            this.loadSearch(config),
            this.loadFilter(config)
        ]);

        return this.mergeIndexes(cards, searchMap, filterMap);
    }

    mergeIndexes(cards, searchMap, filterMap) {
        return cards.map(card => ({
            ...card,
            searchText: searchMap.get(card.id) || '',
            filter: filterMap.get(card.id) || null
        }));
    }

    async fetchCompactRows(filePath, expectedVersion) {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`HTTP错误! 状态: ${response.status}`);
        const text = await response.text();
        return this.parseCompactTsv(text, expectedVersion);
    }

    parseCompactTsv(text, expectedVersion) {
        const lines = text.split(/\r?\n/).filter(line => line.length > 0);
        if (lines.length === 0) return [];

        const versionLine = lines[0].trim();
        if (versionLine !== `#${expectedVersion}`) {
            throw new Error(`TSV版本不匹配: 期望 #${expectedVersion}, 实际 ${versionLine}`);
        }

        return lines.slice(1).map(line => line.split('\t').map(value => this.unescapeTsvValue(value)));
    }

    unescapeTsvValue(value) {
        return String(value ?? '').replace(/\\([\\trn])/g, (_, ch) => {
            if (ch === 't') return '\t';
            if (ch === 'r') return '\r';
            if (ch === 'n') return '\n';
            return '\\';
        });
    }

    parseOptionalNumber(value) {
        if (value === undefined || value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
}
