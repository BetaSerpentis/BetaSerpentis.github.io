// core/PokemonData.js
class PokemonData {
  constructor() {
    this.pokemons = new Map();
    this.pokemonsByType = new Map();
    this.legendaryList = [];
    this.mythicalList = [];
    this.transformers = [];
    this.typeColors = null;
  }

  async loadData(jsonPath) {
    try {
      const response = await fetch(jsonPath);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const config = await response.json();
      
      // 初始化类型索引
      Object.keys(config.typeColors || {}).forEach(type => {
        this.pokemonsByType.set(type, []);
      });
      
      // 处理每只宝可梦
      config.pokemons.forEach(p => {
        this.pokemons.set(p.id, p);
        
        // 按类型索引（考虑双属性）
        const types = [p.type1, p.type2].filter(Boolean);
        types.forEach(type => {
          if (!this.pokemonsByType.has(type)) {
            this.pokemonsByType.set(type, []);
          }
          this.pokemonsByType.get(type).push(p);
        });
        
        // 特殊分类
        if (p.isLegendary) this.legendaryList.push(p);
        if (p.isMythical) this.mythicalList.push(p);
        if (p.isTransformer) this.transformers.push(p);
      });
      
      this.typeColors = config.typeColors;
      console.log(`数据加载成功: ${this.pokemons.size}只宝可梦`);
      return true;
    } catch (error) {
      console.error('加载宝可梦数据失败:', error);
      return false;
    }
  }

  // 根据属性获取宝可梦
  getPokemonsByType(type, options = {}) {
    let list = this.pokemonsByType.get(type) || [];
    
    // 筛选条件
    if (options.stage) {
      list = list.filter(p => p.stage === options.stage);
    }
    if (options.excludeIds && options.excludeIds.length > 0) {
      list = list.filter(p => !options.excludeIds.includes(p.id));
    }
    if (options.includeTransformers === false) {
      list = list.filter(p => !p.isTransformer);
    }
    
    // ✅ 新增：排除传说宝可梦
    if (options.excludeLegendary === true) {
        list = list.filter(p => !p.isLegendary);
    }
    
    // ✅ 新增：排除幻之宝可梦
    if (options.excludeMythical === true) {
        list = list.filter(p => !p.isMythical);
    }
    
    return list;
  }

  // 根据ID获取宝可梦
  getPokemonById(id) {
    return this.pokemons.get(id);
  }

  // 获取所有属性列表
  getAllTypes() {
    return Array.from(this.pokemonsByType.keys());
  }
}

export default PokemonData;