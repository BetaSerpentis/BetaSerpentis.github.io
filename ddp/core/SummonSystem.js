// core/SummonSystem.js
class PokemonInstance {
  constructor(pokemonData, gridIndex) {
    this.id = pokemonData.id;
    this.data = pokemonData;
    this.gridIndex = gridIndex;
    this.currentTypes = [pokemonData.type1, pokemonData.type2].filter(Boolean);
    this.isShiny = false;
    this.isTransformed = false;
    this.transformedFrom = null;
  }

  // 变身方法
  transformInto(targetInstance) {
    this.transformedFrom = this.data;
    this.data = targetInstance.data;
    this.currentTypes = [...targetInstance.currentTypes];
    this.isTransformed = true;
    console.log(`${this.transformedFrom.name} 变身成了 ${this.data.name}!`);
  }
}

class SummonSystem {
  constructor(pokemonData, gameBoard) {
    this.data = pokemonData;
    this.board = gameBoard;
  }

  // SummonSystem.js 中需要修复召唤逻辑：
  summonPokemon(gridIndex) {
      // 步骤1: 判定是否为变身者 (3%概率)
      const isTransformer = Math.random() < 0.03;
      if (isTransformer) {
          const transformer = this.getRandomTransformer();
          if (transformer) {
              // 检查是否已经出场过（如果是梦幻）
              if (transformer.isMythical && this.board.summonedMythicalIds.has(transformer.id)) {
                  console.log(`${transformer.name} 已经出场过，重新召唤普通宝可梦`);
                  // 重新走普通召唤流程
                  return this.summonRegularPokemon(gridIndex);
              }
              
              const instance = new PokemonInstance(transformer, gridIndex);
              
              // 记录出场（如果是梦幻）
              if (transformer.isMythical) {
                  this.board.summonedMythicalIds.add(transformer.id);
              }
              
              console.log(`召唤变身者: ${transformer.name}`);
              return instance;
          }
      }
      
      return this.summonRegularPokemon(gridIndex);
  }

  // 新增方法：召唤普通宝可梦（不含变身者）
  summonRegularPokemon(gridIndex) {
    // 步骤2-6的原有逻辑，但不包含变身者判定
    const allTypes = this.data.getAllTypes();
    const randomType = allTypes[Math.floor(Math.random() * allTypes.length)];

    // 步骤3: 判定传说/幻之
    let targetPokemon = null;
    const rand = Math.random();
    
    // 传说宝可梦概率: 2%
    if (rand < 0.02) {
      targetPokemon = this.getRandomLegendary(randomType);
    }
    // 幻之宝可梦概率: 1% (累计3%)
    else if (rand < 0.03) {
      targetPokemon = this.getRandomMythical(randomType);
    }

    // 步骤4: 普通宝可梦
    if (!targetPokemon) {
      const ordinaryPokemons = this.data.getPokemonsByType(randomType, {
        stage: '基础',
        excludeIds: [...this.board.summonedLegendaryIds, ...this.board.summonedMythicalIds],
        includeTransformers: false,
        excludeLegendary: true,
        excludeMythical: true
      });
      
      if (ordinaryPokemons.length > 0) {
        targetPokemon = ordinaryPokemons[Math.floor(Math.random() * ordinaryPokemons.length)];
      } else {
        // 保底机制
        const allOfType = this.data.getPokemonsByType(randomType);
        targetPokemon = allOfType[Math.floor(Math.random() * allOfType.length)];
      }
    }

    // 步骤5: 记录特殊宝可梦
    if (targetPokemon.isLegendary) {
      this.board.summonedLegendaryIds.add(targetPokemon.id);
    }
    if (targetPokemon.isMythical) {
      this.board.summonedMythicalIds.add(targetPokemon.id);
    }

    // 步骤6: 创建实例并判定异色
    const instance = new PokemonInstance(targetPokemon, gridIndex);
    
    // 判定异色（万分比转小数）
    const shinyRoll = Math.random();
    if (shinyRoll < targetPokemon.shinyProb) {
      instance.isShiny = true;
      console.log(`★ 异色宝可梦: ${targetPokemon.name}`);
    }

    console.log(`召唤成功: ${targetPokemon.name} (${instance.currentTypes.join('+')})`);
    return instance;
  }

  // 修改 getRandomTransformer 方法，排除已出场的幻之变身者
  getRandomTransformer() {
      let list = this.data.transformers;
      
      // 过滤掉已出场的幻之变身者（如梦幻）
      list = list.filter(transformer => {
          if (transformer.isMythical) {
              return !this.board.summonedMythicalIds.has(transformer.id);
          }
          return true;
      });
      
      if (list.length === 0) return null;
      return list[Math.floor(Math.random() * list.length)];
  }

  getRandomLegendary(type) {
    const available = this.data.legendaryList.filter(p => {
      const hasType = p.type1 === type || p.type2 === type;
      const notSummoned = !this.board.summonedLegendaryIds.has(p.id);
      return hasType && notSummoned;
    });
    
    if (available.length === 0) {
      console.log(`该属性${type}的所有传说宝可梦已全部出场`);
      return null;
    }
    
    return available[Math.floor(Math.random() * available.length)];
  }

  getRandomMythical(type) {
    const available = this.data.mythicalList.filter(p => {
      const hasType = p.type1 === type || (p.type2 && p.type2 === type);
      const notSummoned = !this.board.summonedMythicalIds.has(p.id);
      return hasType && notSummoned;
    });
    
    if (available.length === 0) {
      console.log(`该属性${type}的所有幻之宝可梦已全部出场`);
      return null;
    }
    
    return available[Math.floor(Math.random() * available.length)];
  }
}

export { PokemonInstance, SummonSystem };