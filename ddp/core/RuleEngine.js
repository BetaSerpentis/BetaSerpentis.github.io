// core/RuleEngine.js
class RuleEngine {
  constructor(gameBoard) {
    this.board = gameBoard;
  }

  // RuleEngine.js - 修改checkAllRules方法
  checkAllRules() {
      const rewards = [];
      
      // 1. 检查命定属性
      rewards.push(...this.checkChosenType());
      
      // 2. 检查对子
      rewards.push(...this.checkPairs());
      
      // 3. 检查三连
      rewards.push(...this.checkThreeInRow());
      
      // 4. 检查全不同
      rewards.push(...this.checkAllDifferent());
      
      return rewards;
  }

  // 新增：只检查非命定属性规则
  checkOtherRules() {
      const rewards = [];
      
      // 检查对子
      rewards.push(...this.checkPairs());
      
      // 检查三连
      rewards.push(...this.checkThreeInRow());
      
      // 检查全不同
      rewards.push(...this.checkAllDifferent());
      
      return rewards;
  }

  // RuleEngine.js - 修改checkChosenType方法
  checkChosenType() {
      const rewards = [];
      this.board.grid.forEach((pokemon, index) => {
          if (pokemon && !pokemon.isTransformed && !pokemon.hasTriggeredChosenType) {
              // 检查是否包含玩家选择的属性
              if (pokemon.currentTypes.includes(this.board.playerChosenType)) {
                  // 只奖励球，不移除宝可梦
                  rewards.push({ 
                      ruleName: '命定属性', 
                      balls: 1, 
                      indexes: [], // 关键：空数组表示不移除任何宝可梦
                      description: `${pokemon.data.name}是${this.board.playerChosenType}属性`
                  });
                  pokemon.hasTriggeredChosenType = true; // 标记已触发
              }
          }
      });
      return rewards;
  }

  checkPairs() {
    const rewards = [];
    const pairsFound = new Set(); // 防止重复检测
    
    for (let i = 0; i < this.board.grid.length; i++) {
      const pokemon1 = this.board.grid[i];
      if (!pokemon1) continue;
      
      for (let j = i + 1; j < this.board.grid.length; j++) {
        const pokemon2 = this.board.grid[j];
        if (!pokemon2) continue;
        
        // 检查是否有共同属性（考虑双属性）
        const commonTypes = this.getCommonTypes(pokemon1, pokemon2);
        
        if (commonTypes.length > 0 && !pairsFound.has(i) && !pairsFound.has(j)) {
          // 找到一对可消除的
          rewards.push({
            ruleName: '对对碰',
            balls: 1,
            indexes: [i, j],
            description: `${pokemon1.data.name}和${pokemon2.data.name}都是${commonTypes[0]}属性`
          });
          
          // 标记已找到
          pairsFound.add(i);
          pairsFound.add(j);
          
          // 从格子上移除
          this.board.grid[i] = null;
          this.board.grid[j] = null;
          
          // 找到一对后跳出内层循环
          break;
        }
      }
    }
    
    return rewards;
  }

  checkThreeInRow() {
    const lines = [
      [0,1,2],[3,4,5],[6,7,8], // 横排
      [0,3,6],[1,4,7],[2,5,8], // 竖排
      [0,4,8],[2,4,6]          // 斜向
    ];
    
    const rewards = [];
    const usedIndexes = new Set();
    
    lines.forEach(line => {
      // 如果线上有任何位置已被其他规则使用，跳过
      if (line.some(idx => usedIndexes.has(idx))) return;
      
      const pokemons = line.map(idx => this.board.grid[idx]).filter(Boolean);
      if (pokemons.length !== 3) return;
      
      // 找出三只宝可梦的共同属性
      const commonTypes = this.getCommonTypes(pokemons[0], pokemons[1], pokemons[2]);
      
      if (commonTypes.length > 0) {
        rewards.push({
          ruleName: '三连消除',
          balls: 5,
          indexes: [...line],
          description: `${pokemons[0].data.name}、${pokemons[1].data.name}、${pokemons[2].data.name}形成${commonTypes[0]}属性三连`
        });
        
        // 移除宝可梦并标记位置已使用
        line.forEach(idx => {
          this.board.grid[idx] = null;
          usedIndexes.add(idx);
        });
      }
    });
    
    return rewards;
  }

  checkAllDifferent() {
    const filledCells = this.board.grid.filter(Boolean);
    if (filledCells.length !== 9) return [];
    
    // 收集所有属性（考虑双属性）
    const allTypes = new Set();
    let hasDuplicateType = false;
    
    for (const pokemon of filledCells) {
      for (const type of pokemon.currentTypes) {
        if (allTypes.has(type)) {
          hasDuplicateType = true;
          break;
        }
        allTypes.add(type);
      }
      if (hasDuplicateType) break;
    }
    
    // 如果没有重复属性且刚好9种不同属性
    if (!hasDuplicateType && allTypes.size === 9) {
      return [{
        ruleName: '全图鉴',
        balls: 9,
        indexes: [0,1,2,3,4,5,6,7,8],
        description: '场上九只宝可梦属性全部不同'
      }];
    }
    
    return [];
  }

  // 获取宝可梦之间的共同属性
  getCommonTypes(...pokemons) {
    if (pokemons.length === 0) return [];
    
    // 从第一只宝可梦的属性开始检查
    const firstTypes = pokemons[0].currentTypes;
    const commonTypes = [];
    
    for (const type of firstTypes) {
      // 检查其他所有宝可梦是否都有这个属性
      const allHaveType = pokemons.every(p => p.currentTypes.includes(type));
      if (allHaveType) {
        commonTypes.push(type);
      }
    }
    
    return commonTypes;
  }

  // 变身者辅助方法：判断变身是否会形成三连
  wouldFormThreeInRow(index, type) {
    // 获取同行、同列、同斜线的位置
    const row = Math.floor(index / 3);
    const col = index % 3;
    
    // 检查行
    const rowIndices = [row*3, row*3+1, row*3+2];
    if (this.checkLineWouldHaveType(rowIndices, index, type, 3)) return true;
    
    // 检查列
    const colIndices = [col, col+3, col+6];
    if (this.checkLineWouldHaveType(colIndices, index, type, 3)) return true;
    
    // 检查对角线
    if (index % 4 === 0) { // 主对角线
      const diag1 = [0, 4, 8];
      if (this.checkLineWouldHaveType(diag1, index, type, 3)) return true;
    }
    if (index % 2 === 0 && index !== 0 && index !== 8) { // 副对角线
      const diag2 = [2, 4, 6];
      if (this.checkLineWouldHaveType(diag2, index, type, 3)) return true;
    }
    
    return false;
  }
  
  checkLineWouldHaveType(indices, changedIndex, newType, requiredCount) {
    let count = 0;
    for (const idx of indices) {
      const pokemon = this.board.grid[idx];
      if (idx === changedIndex) {
        // 这是要变的位置，假设它变成新类型
        if (newType) count++;
      } else if (pokemon && pokemon.currentTypes.includes(newType)) {
        count++;
      }
    }
    return count >= requiredCount;
  }
}

export default RuleEngine;