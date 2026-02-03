// core/GameBoard.js
import { SummonSystem } from './SummonSystem.js';
import RuleEngine from './RuleEngine.js';
import EvolutionManager from './EvolutionManager.js';

class GameBoard {
  constructor(pokemonData, playerChosenType = '火', initialBalls = 9) {
    this.pokemonData = pokemonData;
    this.playerChosenType = playerChosenType;
    this.grid = new Array(9).fill(null);
    this.ballsRemaining = initialBalls;
    
    // 系统模块
    this.summonSystem = new SummonSystem(pokemonData, this);
    this.ruleEngine = new RuleEngine(this);
    this.evolutionManager = new EvolutionManager(pokemonData, this);
    
    // 状态记录
    this.summonedLegendaryIds = new Set();
    this.summonedMythicalIds = new Set();
    this.totalBallsAdded = 0;
    this.gameLog = [];
    
    console.log(`游戏初始化: 选择属性[${playerChosenType}], 初始精灵球: ${initialBalls}`);
  }

  // 主召唤方法
  summonPokemon() {
    if (this.ballsRemaining <= 0) {
      this.logGameEvent('错误', '没有精灵球了！');
      return null;
    }
    
    this.ballsRemaining--;
    this.logGameEvent('行动', `使用1个精灵球，剩余: ${this.ballsRemaining}`);
    
    // 1. 找到空位
    const emptySlots = [];
    this.grid.forEach((cell, index) => {
      if (cell === null) emptySlots.push(index);
    });
    
    if (emptySlots.length === 0) {
      this.logGameEvent('错误', '场地已满！');
      this.ballsRemaining++; // 退回精灵球
      return null;
    }
    
    const targetIndex = emptySlots[Math.floor(Math.random() * emptySlots.length)];
    
    // 2. 召唤宝可梦
    const summonedPokemon = this.summonSystem.summonPokemon(targetIndex);
    this.grid[targetIndex] = summonedPokemon;
    
    // 3. 处理特殊奖励（异色、传说、幻之）
    const specialRewards = this.processSpecialRewards(summonedPokemon);
    if (specialRewards.balls > 0) {
      this.ballsRemaining += specialRewards.balls;
      this.totalBallsAdded += specialRewards.balls;
      this.logGameEvent('奖励', specialRewards.description);
    }
    
    // 4. 处理变身者
    if (summonedPokemon.data.isTransformer) {
      this.handleTransformer(summonedPokemon, targetIndex);
    }
    
    // 5. 检查规则
    const ruleRewards = this.ruleEngine.checkAllRules();
    this.processRuleRewards(ruleRewards);
    
    // 6. 检查进化
    const evolutionEvents = this.evolutionManager.checkEvolutions();
    this.processEvolutionEvents(evolutionEvents);
    
    // 7. 检查游戏是否结束
    this.checkGameEnd();
    
    // 8. 更新显示（控制台版本）
    this.displayGrid();
    
    return summonedPokemon;
  }

  processSpecialRewards(pokemonInstance) {
    let balls = 0;
    let description = '';
    
    // 异色奖励
    if (pokemonInstance.isShiny && !pokemonInstance.isTransformed) {
      balls += 2;
      description += `异色${pokemonInstance.data.name} +2球 `;
    }
    
    // 传说宝可梦奖励
    if (pokemonInstance.data.isLegendary && !pokemonInstance.isTransformed) {
      balls += 1;
      description += `传说宝可梦 +1球 `;
    }
    
    // 幻之宝可梦奖励
    if (pokemonInstance.data.isMythical && !pokemonInstance.isTransformed) {
      balls += 2;
      description += `幻之宝可梦 +2球 `;
    }
    
    // 如果有获得球，立即进行进化判定
    if (balls > 0) {
        this.checkEvolutionsOnBallsAdded();
    }
    
    return { balls, description: description.trim() };
  }

  handleTransformer(transformerInstance, index) {
    // 获取场上其他非变身者宝可梦
    const potentialTargets = this.grid
      .map((p, i) => (p && !p.data.isTransformer && i !== index) ? { pokemon: p, index: i } : null)
      .filter(Boolean);
    
    if (potentialTargets.length === 0) {
      this.logGameEvent('变身', `${transformerInstance.data.name}找不到变身目标`);
      return;
    }
    
    // 寻找最佳变身目标
    let bestTarget = null;
    let bestScore = -1;
    
    for (const { pokemon, index: targetIndex } of potentialTargets) {
      let score = 0;
      
      // 尝试每种可能的属性
      for (const type of pokemon.currentTypes) {
        // 检查是否会形成三连
        if (this.ruleEngine.wouldFormThreeInRow(index, type)) {
          score = 100; // 最高优先级
          break;
        }
        
        // 检查是否会形成对子
        const wouldFormPair = this.checkWouldFormPair(index, type);
        if (wouldFormPair) {
          score = Math.max(score, 50);
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestTarget = { pokemon, targetIndex };
      }
    }
    
    // 执行变身
    if (bestTarget) {
      transformerInstance.transformInto(bestTarget.pokemon);
      this.logGameEvent('变身', `${transformerInstance.transformedFrom.name}变身成${bestTarget.pokemon.data.name}`);
      
      // 变身可能需要重新检查规则
      const ruleRewards = this.ruleEngine.checkAllRules();
      this.processRuleRewards(ruleRewards);
    }
  }

  checkWouldFormPair(index, type) {
    for (let i = 0; i < this.grid.length; i++) {
      if (i === index || !this.grid[i]) continue;
      if (this.grid[i].currentTypes.includes(type)) {
        return true;
      }
    }
    return false;
  }

  // 在 processRuleRewards 方法中
  processRuleRewards(rewards) {
      let totalBallsFromRules = 0;
      
      rewards.forEach(reward => {
          this.ballsRemaining += reward.balls;
          this.totalBallsAdded += reward.balls;
          totalBallsFromRules += reward.balls;
          this.logGameEvent('规则', `${reward.ruleName}: ${reward.description} +${reward.balls}球`);
          
          // 消除宝可梦（命定属性除外）
          if (reward.indexes && reward.indexes.length > 0) {
              reward.indexes.forEach(idx => {
                  this.grid[idx] = null;
              });
          }
      });
      
      // 如果有从规则中获得球，进行进化判定
      if (totalBallsFromRules > 0) {
          this.checkEvolutionsOnBallsAdded();
      }
  }

  // 新增方法：在获得球时检查进化
  checkEvolutionsOnBallsAdded() {
      const evolutionEvents = this.evolutionManager.checkEvolutions();
      this.processEvolutionEvents(evolutionEvents);
  }

// processEvolutionEvents 方法保持原样
processEvolutionEvents(evolutionEvents) {
    evolutionEvents.forEach(event => {
        this.ballsRemaining += event.rewardBalls;
        this.totalBallsAdded += event.rewardBalls;
        
        let desc = `${event.oldPokemon}进化为${event.newPokemon}`;
        if (event.rewardBalls > 0) desc += ` +${event.rewardBalls}球`;
        if (event.isShiny) desc += ' (异色)';
        
        this.logGameEvent('进化', desc);
        
        // 进化后检查规则（因为属性可能改变）
        const ruleRewards = this.ruleEngine.checkAllRules();
        this.processRuleRewards(ruleRewards);
    });
}

  checkGameEnd() {
    const emptySlots = this.grid.filter(cell => cell === null).length;
    const hasPairs = this.hasRemainingPairs();
    
    // 游戏结束条件：没有精灵球且没有可消除的对子
    if (this.ballsRemaining <= 0 && !hasPairs && emptySlots > 0) {
      this.logGameEvent('游戏结束', '没有精灵球且没有可消除的对子，游戏结束！');
      return true;
    }
    
    return false;
  }

  hasRemainingPairs() {
    for (let i = 0; i < this.grid.length; i++) {
      if (!this.grid[i]) continue;
      for (let j = i + 1; j < this.grid.length; j++) {
        if (!this.grid[j]) continue;
        
        const commonTypes = this.ruleEngine.getCommonTypes(this.grid[i], this.grid[j]);
        if (commonTypes.length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  displayGrid() {
    console.log('\n=== 当前场地 ===');
    for (let row = 0; row < 3; row++) {
      let rowText = '';
      for (let col = 0; col < 3; col++) {
        const index = row * 3 + col;
        const pokemon = this.grid[index];
        
        if (pokemon) {
          const typeSymbol = pokemon.currentTypes[0]?.charAt(0) || '?';
          const shinySymbol = pokemon.isShiny ? '★' : ' ';
          const transformerSymbol = pokemon.data.isTransformer ? '变' : ' ';
          rowText += `[${shinySymbol}${typeSymbol}${transformerSymbol}]`;
        } else {
          rowText += '[ 空 ]';
        }
        rowText += ' ';
      }
      console.log(rowText);
    }
    console.log(`精灵球: ${this.ballsRemaining}, 累计获得: ${this.totalBallsAdded}`);
  }

  logGameEvent(type, message) {
    const event = { type, message, time: new Date().toLocaleTimeString() };
    this.gameLog.push(event);
    console.log(`[${type}] ${message}`);
  }

  getGameStats() {
    const stats = {
      totalSummons: this.gameLog.filter(e => e.type === '行动').length,
      totalRewards: this.totalBallsAdded,
      legendarySummoned: this.summonedLegendaryIds.size,
      mythicalSummoned: this.summonedMythicalIds.size,
      gameLog: this.gameLog
    };
    return stats;
  }

    // 批量投放所有精灵球
    async summonAllBalls() {
        if (this.ballsRemaining <= 0) {
            this.logGameEvent('错误', '没有精灵球了！');
            return null;
        }
        
        this.logGameEvent('行动', `批量投放 ${this.ballsRemaining} 个精灵球`);
        
        // 阶段1: 收集所有要召唤的位置
        const summonQueue = [];
        let ballsToUse = this.ballsRemaining;
        
        // 找出所有空位
        const emptySlots = this.grid
            .map((cell, index) => cell === null ? index : -1)
            .filter(i => i !== -1);
        
        // 计算最多能召唤多少只（受空位限制）
        const maxSummons = Math.min(ballsToUse, emptySlots.length);
        
        if (maxSummons === 0) {
            this.logGameEvent('错误', '场地已满！');
            return null;
        }
        
        // 创建召唤队列（随机顺序）
        const shuffledSlots = [...emptySlots].sort(() => Math.random() - 0.5);
        const slotsToUse = shuffledSlots.slice(0, maxSummons);
        
        // 消耗所有精灵球
        this.ballsRemaining -= maxSummons;
        
        // 阶段2: 依次召唤所有宝可梦（但先不处理规则）
        const summonedPokemons = [];
        
        for (let i = 0; i < slotsToUse.length; i++) {
            const targetIndex = slotsToUse[i];
            
            // 召唤宝可梦
            const summonedPokemon = this.summonSystem.summonPokemon(targetIndex);
            this.grid[targetIndex] = summonedPokemon;
            summonedPokemons.push({
                pokemon: summonedPokemon,
                index: targetIndex
            });
            
            // 记录特殊奖励（先累计，最后处理）
            const specialRewards = this.calculateSpecialRewards(summonedPokemon);
            if (specialRewards.balls > 0) {
                // 这里先记录，最后统一加球
                this.pendingSpecialRewards = (this.pendingSpecialRewards || 0) + specialRewards.balls;
                this.logGameEvent('奖励', `${specialRewards.description} (待处理)`);
            }
            
            // 显示进度（可选）
            this.logGameEvent('进度', `已召唤 ${i+1}/${slotsToUse.length}: ${summonedPokemon.data.name}`);
            
            // 添加一点延迟，增加视觉效果
            await this.delay(100); // 100ms延迟
        }
        
        // 阶段3: 批量处理所有后续逻辑
        await this.processBatchEffects(summonedPokemons);
        
        return summonedPokemons;
    }
    
    // 计算特殊奖励（不实际加球）
    calculateSpecialRewards(pokemonInstance) {
        let balls = 0;
        let description = '';
        
        // 异色奖励
        if (pokemonInstance.isShiny && !pokemonInstance.isTransformed) {
            balls += 2;
            description += `异色${pokemonInstance.data.name} +2球 `;
        }
        
        // 传说宝可梦奖励
        if (pokemonInstance.data.isLegendary && !pokemonInstance.isTransformed) {
            balls += 1;
            description += `传说宝可梦 +1球 `;
        }
        
        // 幻之宝可梦奖励
        if (pokemonInstance.data.isMythical && !pokemonInstance.isTransformed) {
            balls += 2;
            description += `幻之宝可梦 +2球 `;
        }
        
        return { balls, description: description.trim() };
    }
    
    // 批量处理所有效果
    async processBatchEffects(summonedPokemons) {
        this.logGameEvent('处理', '开始批量处理效果...');
        
        let totalBallsAdded = 0;
        
        // 1. 先处理特殊奖励
        if (this.pendingSpecialRewards > 0) {
            this.ballsRemaining += this.pendingSpecialRewards;
            totalBallsAdded += this.pendingSpecialRewards;
            this.logGameEvent('奖励', `特殊奖励总计: +${this.pendingSpecialRewards}球`);
            this.pendingSpecialRewards = 0;
        }
        
        // 2. 处理变身者
        for (const { pokemon, index } of summonedPokemons) {
            if (pokemon.data.isTransformer) {
                this.logGameEvent('变身', `处理变身者: ${pokemon.data.name}`);
                this.handleTransformer(pokemon, index);
                await this.delay(50); // 小延迟
            }
        }
        
        // 3. 处理规则（反复处理直到没有可触发的规则）
        let iteration = 0;
        let totalRuleBalls = 0;
        
        do {
            iteration++;
            this.logGameEvent('规则', `第${iteration}轮规则检查`);
            
            const ruleRewards = this.ruleEngine.checkAllRules();
            const ruleBalls = this.calculateRuleBalls(ruleRewards);
            
            if (ruleBalls > 0) {
                this.ballsRemaining += ruleBalls;
                totalBallsAdded += ruleBalls;
                totalRuleBalls += ruleBalls;
                
                // 应用规则消除
                ruleRewards.forEach(reward => {
                    this.logGameEvent('规则', `${reward.ruleName}: ${reward.description} +${reward.balls}球`);
                    
                    if (reward.ruleName !== '命定属性' && reward.indexes && reward.indexes.length > 0) {
                        reward.indexes.forEach(idx => {
                            this.grid[idx] = null;
                        });
                    }
                });
                
                // 如果有消除，需要重新检查
                await this.delay(100);
            } else {
                break; // 没有规则触发，退出循环
            }
            
            // 防止无限循环
            if (iteration > 20) {
                this.logGameEvent('警告', '规则处理循环超过20次，强制退出');
                break;
            }
        } while (true);
        
        if (totalRuleBalls > 0) {
            this.logGameEvent('规则', `规则奖励总计: +${totalRuleBalls}球`);
        }
        
        // 4. 处理进化（只在最后处理一次）
        this.logGameEvent('进化', '开始进化判定');
        const evolutionEvents = this.evolutionManager.checkEvolutions();
        let evolutionBalls = 0;
        
        evolutionEvents.forEach(event => {
            this.ballsRemaining += event.rewardBalls;
            totalBallsAdded += event.rewardBalls;
            evolutionBalls += event.rewardBalls;
            
            let desc = `${event.oldPokemon}进化为${event.newPokemon}`;
            if (event.rewardBalls > 0) desc += ` +${event.rewardBalls}球`;
            if (event.isShiny) desc += ' (异色)';
            
            this.logGameEvent('进化', desc);
        });
        
        if (evolutionBalls > 0) {
            this.logGameEvent('进化', `进化奖励总计: +${evolutionBalls}球`);
        }
        
        // 5. 更新累计总数
        this.totalBallsAdded += totalBallsAdded;
        
        // 6. 检查游戏结束
        this.checkGameEnd();
        
        this.logGameEvent('处理', `批量处理完成，总计获得: +${totalBallsAdded}球`);
        this.logGameEvent('状态', `剩余精灵球: ${this.ballsRemaining}`);
    }
    
    // 计算规则奖励的球数
    calculateRuleBalls(rewards) {
        return rewards.reduce((total, reward) => total + reward.balls, 0);
    }
    
    // 延迟辅助方法
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }  
}

export default GameBoard;