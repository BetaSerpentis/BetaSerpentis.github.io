// core/GameBoard.js - 完整简化版本
import { SummonSystem } from './SummonSystem.js';
import RuleEngine from './RuleEngine.js';
import EvolutionManager from './EvolutionManager.js';

class GameBoard {
    // GameBoard.js - 在构造函数中添加
    constructor(pokemonData, playerChosenType = '火', initialBalls = 9, uiCallback = null) {
        this.pokemonData = pokemonData;
        this.playerChosenType = playerChosenType;
        this.grid = new Array(9).fill(null);
        this.ballsRemaining = initialBalls;
        
        this.summonSystem = new SummonSystem(pokemonData, this);
        this.ruleEngine = new RuleEngine(this);
        this.evolutionManager = new EvolutionManager(pokemonData, this);
        
        this.summonedLegendaryIds = new Set();
        this.summonedMythicalIds = new Set();
        this.totalBallsAdded = 0;
        this.gameLog = [];
        
        // 确保pendingRewards是数组
        this.pendingRewards = [];
        
        this.uiCallback = uiCallback;
        
        console.log(`游戏初始化: 选择属性[${playerChosenType}], 初始精灵球: ${initialBalls}`);
    }

    // 添加设置命定属性的方法
    setChosenType(type) {
        this.playerChosenType = type;
        console.log(`命定属性已更新: ${type}`);
        
        // 重置所有宝可梦的hasTriggeredChosenType标记
        this.grid.forEach(pokemon => {
            if (pokemon) {
                pokemon.hasTriggeredChosenType = false;
            }
        });
    }

    // GameBoard.js - 修改召唤方法中的变身处理
    summonPokemon() {
        if (this.ballsRemaining <= 0) {
            this.logGameEvent('错误', '没有精灵球了！');
            return null;
        }
        
        this.ballsRemaining--;
        this.logGameEvent('行动', `使用1个精灵球，剩余: ${this.ballsRemaining}`);
        
        const emptySlots = [];
        this.grid.forEach((cell, index) => {
            if (cell === null) emptySlots.push(index);
        });
        
        if (emptySlots.length === 0) {
            this.logGameEvent('错误', '场地已满！');
            this.ballsRemaining++;
            return null;
        }
        
        const targetIndex = emptySlots[Math.floor(Math.random() * emptySlots.length)];
        const summonedPokemon = this.summonSystem.summonPokemon(targetIndex);
        this.grid[targetIndex] = summonedPokemon;
        
        // 召唤成功消息
        let summonMessage = `召唤了${summonedPokemon.data.name}`;
        if (summonedPokemon.isShiny) summonMessage += ' (异色✨)';
        if (summonedPokemon.data.isLegendary) summonMessage += ' (传说🌟)';
        if (summonedPokemon.data.isMythical) summonMessage += ' (幻之💫)';
        if (summonedPokemon.data.isTransformer) summonMessage += ' (变身者🌀)';
        
        this.logGameEvent('召唤', summonMessage);
        
        // 处理特殊奖励（异色、传说、幻之）
        const specialRewards = this.processSpecialRewards(summonedPokemon);
        if (specialRewards.balls > 0) {
            this.ballsRemaining += specialRewards.balls;
            this.totalBallsAdded += specialRewards.balls;
            
            specialRewards.rewards.forEach(reward => {
                this.logGameEvent('奖励', reward.message);
            });
        }
        
        // 立即检查命定属性规则
        const chosenTypeRewards = this.ruleEngine.checkChosenType();
        if (chosenTypeRewards.length > 0) {
            this.processImmediateRuleRewards(chosenTypeRewards);
        }
        
        // 处理变身者 - 改为返回变身信息，让UI层处理动画
        if (summonedPokemon.data.isTransformer) {
            // 寻找变身目标
            const transformInfo = this.prepareTransform(summonedPokemon, targetIndex);
            
            // 返回变身信息，让UI层处理
            summonedPokemon.transformInfo = transformInfo;
        }
        
        // 检查其他规则（延迟一点，让变身先完成）
        setTimeout(() => {
            const otherRuleRewards = this.ruleEngine.checkOtherRules();
            if (otherRuleRewards.length > 0) {
                this.processRuleRewards(otherRuleRewards);
            }
        }, summonedPokemon.data.isTransformer ? 1500 : 300); // 如果是变身者，延迟更久
        
        // 检查进化
        setTimeout(() => {
            const evolutionEvents = this.evolutionManager.checkEvolutions();
            if (evolutionEvents.length > 0) {
                this.processEvolutionEvents(evolutionEvents);
            }
        }, summonedPokemon.data.isTransformer ? 1600 : 500);
        
        return summonedPokemon;
    }

    // 新增：准备变身信息（不立即执行变身）
    prepareTransform(transformerInstance, index) {
        console.log(`[变身] 准备变身: ${transformerInstance.data.name}, 格子 ${index}`);
        
        const potentialTargets = this.grid
            .map((p, i) => (p && !p.data.isTransformer && i !== index) ? { pokemon: p, index: i } : null)
            .filter(Boolean);
        
        if (potentialTargets.length === 0) {
            console.log(`[变身] ${transformerInstance.data.name}找不到变身目标`);
            return null;
        }
        
        // 寻找最佳变身目标
        let bestTarget = null;
        let bestScore = -1;
        
        for (const { pokemon, index: targetIndex } of potentialTargets) {
            let score = 0;
            
            for (const type of pokemon.currentTypes) {
                if (this.ruleEngine.wouldFormThreeInRow(index, type)) {
                    score = 100;
                    break;
                }
                
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
        
        if (bestTarget) {
            console.log(`[变身] 找到变身目标: ${bestTarget.pokemon.data.name}, 格子 ${bestTarget.targetIndex}`);
            
            return {
                transformer: transformerInstance,
                transformerIndex: index,
                targetPokemon: bestTarget.pokemon,
                targetIndex: bestTarget.targetIndex,
                bestScore: bestScore
            };
        }
        
        return null;
    }

    // 修改executeTransform，变身奖励也加入pendingRewards
    executeTransform(transformInfo) {
        if (!transformInfo) return;
        
        const { transformer, transformerIndex, targetPokemon } = transformInfo;
        
        console.log(`[变身] 执行变身: ${transformer.data.name} -> ${targetPokemon.data.name}`);
        
        transformer.transformInto(targetPokemon);
        
        let transformMessage = `${transformer.transformedFrom.name}变身成了${targetPokemon.data.name}`;
        
        const wouldFormPair = this.checkWouldFormPair(transformerIndex, targetPokemon.currentTypes[0]);
        const wouldFormThree = this.ruleEngine.wouldFormThreeInRow(transformerIndex, targetPokemon.currentTypes[0]);
        
        if (wouldFormThree) {
            transformMessage += '，可能会形成三连！';
        } else if (wouldFormPair) {
            transformMessage += '，凑成了一对！';
        }
        
        this.logGameEvent('变身', transformMessage);
        
        // 变身奖励已经在processSpecialRewards中处理了
        
        // 立即检查规则
        const ruleRewards = this.ruleEngine.checkAllRules();
        if (ruleRewards.length > 0) {
            this.processRuleRewards(ruleRewards);
        }
        
        return transformer;
    }

    // 在GameBoard.js中确保logGameEvent被调用
    processImmediateRuleRewardsForTransform(rewards) {
        let totalBallsFromRules = 0;
        
        rewards.forEach(reward => {
            this.ballsRemaining += reward.balls;
            this.totalBallsAdded += reward.balls;
            totalBallsFromRules += reward.balls;
            
            // 确保消息被记录
            let message = '';
            switch(reward.ruleName) {
                case '对对碰':
                    message = `宝可梦凑对，精灵球+${reward.balls}`;
                    break;
                case '三连消除':
                    message = `三连消除，精灵球+${reward.balls}`;
                    break;
                default:
                    message = `${reward.ruleName}，精灵球+${reward.balls}`;
            }
            
            console.log(`[变身规则触发] ${message}`);
            this.logGameEvent('规则', message); // 确保这行被执行
            
            // 消除宝可梦
            if (reward.indexes && reward.indexes.length > 0) {
                reward.indexes.forEach(idx => {
                    this.grid[idx] = null;
                });
            }
        });

        if (totalBallsFromRules > 0) {
            // 延迟一点再检查进化
            setTimeout(() => {
                const evolutionEvents = this.evolutionManager.checkEvolutions();
                this.processEvolutionEvents(evolutionEvents);
            }, 200);
        }
    }

    processImmediateRuleRewards(rewards, triggerIndex = null) {
        rewards.forEach(reward => {
            let message = `属性一致，精灵球+${reward.balls}`;
            this.logGameEvent('规则', message);
            
            this.pendingRewards = this.pendingRewards || [];
            this.pendingRewards.push({
                balls: reward.balls,
                triggerIndex: triggerIndex,
                message: message,
                type: 'chosen', // 命定属性类型
                order: Date.now()
            });
        });
    }

    // 修改processSpecialRewards，只返回奖励信息不加球
    processSpecialRewards(pokemonInstance, index) {
        let balls = 0;
        let description = '';
        const rewards = [];
        
        // 异色奖励
        if (pokemonInstance.isShiny && !pokemonInstance.isTransformed) {
            balls += 2;
            description += `异色${pokemonInstance.data.name} +2球 `;
            rewards.push({
                type: 'special', // 特殊奖励类型
                message: `异色${pokemonInstance.data.name}出现，精灵球+2`,
                balls: 2,
                triggerIndex: index
            });
        }
        
        // 传说宝可梦奖励
        if (pokemonInstance.data.isLegendary && !pokemonInstance.isTransformed) {
            balls += 1;
            description += `传说宝可梦 +1球 `;
            rewards.push({
                type: '传说奖励',
                message: `传说宝可梦${pokemonInstance.data.name}出现，精灵球+1`,
                balls: 1,
                triggerIndex: index
            });
        }
        
        // 幻之宝可梦奖励
        if (pokemonInstance.data.isMythical && !pokemonInstance.isTransformed) {
            balls += 2;
            description += `幻之宝可梦 +2球 `;
            rewards.push({
                type: '幻之奖励',
                message: `幻之宝可梦${pokemonInstance.data.name}出现，精灵球+2`,
                balls: 2,
                triggerIndex: index
            });
        }
        
        // 变身奖励
        if (pokemonInstance.isTransformed && pokemonInstance.transformedFrom) {
            const originalName = pokemonInstance.transformedFrom.name;
            const newName = pokemonInstance.data.name;
            
            if (pokemonInstance.data.isLegendary) {
                balls += 1;
                description += `变身传说 +1球 `;
                rewards.push({
                    type: '变身奖励',
                    message: `${originalName}变身成了传说宝可梦${newName}，精灵球+1`,
                    balls: 1,
                    triggerIndex: index
                });
            }
            
            if (pokemonInstance.data.isMythical) {
                balls += 2;
                description += `变身幻之 +2球 `;
                rewards.push({
                    type: '变身奖励',
                    message: `${originalName}变身成了幻之宝可梦${newName}，精灵球+2`,
                    balls: 2,
                    triggerIndex: index
                });
            }
        }
        
        return { 
            balls, 
            description: description.trim(),
            rewards
        };
    }

  // 修改handleTransformer，确保变身事件立即显示
  handleTransformer(transformerInstance, index) {
      const potentialTargets = this.grid
          .map((p, i) => (p && !p.data.isTransformer && i !== index) ? { pokemon: p, index: i } : null)
          .filter(Boolean);
      
      if (potentialTargets.length === 0) {
          this.logGameEvent('变身', `${transformerInstance.data.name}找不到变身目标`);
          return;
      }
      
      let bestTarget = null;
      let bestScore = -1;
      
      for (const { pokemon, index: targetIndex } of potentialTargets) {
          let score = 0;
          
          for (const type of pokemon.currentTypes) {
              if (this.ruleEngine.wouldFormThreeInRow(index, type)) {
                  score = 100;
                  break;
              }
              
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
      
      if (bestTarget) {
          transformerInstance.transformInto(bestTarget.pokemon);
          this.logGameEvent('变身', `${transformerInstance.transformedFrom.name}变身成了${bestTarget.pokemon.data.name}`);
          
          // 变身可能需要重新检查规则（延迟一点）
          setTimeout(() => {
              const ruleRewards = this.ruleEngine.checkAllRules();
              this.processRuleRewards(ruleRewards);
          }, 300);
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

    // 修改processRuleRewards，确保正确记录消除
    processRuleRewards(rewards) {
        console.log(`[规则] 处理 ${rewards.length} 个规则奖励`);
        let totalBallsFromRules = 0;
        
        rewards.forEach(reward => {
            totalBallsFromRules += reward.balls;
            
            let message = '';
            switch(reward.ruleName) {
                case '对对碰':
                    message = `宝可梦凑对，精灵球+${reward.balls}`;
                    break;
                case '三连消除':
                    message = `三连消除，精灵球+${reward.balls}`;
                    break;
                case '全图鉴':
                    message = `全图鉴达成，精灵球+${reward.balls}`;
                    break;
                default:
                    message = `${reward.ruleName}，精灵球+${reward.balls}`;
            }
            
            this.logGameEvent('规则', message);
            
            // 存储奖励信息
            const triggerIndex = reward.indexes?.[0] || null;
            this.pendingRewards = this.pendingRewards || [];
            // GameBoard.js - 在添加奖励时添加时间戳
            this.pendingRewards.push({
                balls: reward.balls,
                triggerIndex: triggerIndex,
                message: message,
                type: 'rule', // 消除类型
                order: Date.now()
            });
            
            // 消除宝可梦 - 重要！这里要实际消除
            if (reward.indexes && reward.indexes.length > 0) {
                console.log(`[规则] 消除格子: ${reward.indexes}`);
                reward.indexes.forEach(idx => {
                    this.grid[idx] = null;
                });
            }
        });
        
        // 打印当前场地状态
        console.log('[规则] 规则处理后的场地状态:');
        this.displayGrid();
        
        if (totalBallsFromRules > 0) {
            // 延迟一点检查进化
            setTimeout(() => {
                const evolutionEvents = this.evolutionManager.checkEvolutions();
                if (evolutionEvents.length > 0) {
                    this.processEvolutionEvents(evolutionEvents);
                }
            }, 200);
        }
    }

    // GameBoard.js - 修改processEvolutionEvents方法
    processEvolutionEvents(evolutionEvents) {
        evolutionEvents.forEach(event => {
            let desc = `${event.oldPokemon}进化为${event.newPokemon}`;
            if (event.isShiny) desc += ' (异色)';
            this.logGameEvent('进化', desc);
            
            if (event.rewardBalls > 0) {
                let rewardMessage = '';
                if (event.stage === '一阶进化') {
                    rewardMessage = `一阶进化，精灵球+${event.rewardBalls}`;
                } else if (event.stage === '二阶进化') {
                    rewardMessage = `二阶进化，精灵球+${event.rewardBalls}`;
                }
                
                if (rewardMessage) {
                    this.logGameEvent('奖励', rewardMessage);
                    
                    // 确保使用event.index作为triggerIndex
                    this.pendingRewards = this.pendingRewards || [];
                    this.pendingRewards.push({
                        balls: event.rewardBalls,
                        triggerIndex: event.index,  // 确保这里是event.index
                        message: rewardMessage,
                        type: 'evolution',
                        order: Date.now()
                    });
                }
            }
            
            // 进化后重新检查规则
            setTimeout(() => {
                const ruleRewards = this.ruleEngine.checkAllRules();
                this.processRuleRewards(ruleRewards);
            }, 300);
        });
    }

  checkGameEnd() {
    const emptySlots = this.grid.filter(cell => cell === null).length;
    const hasPairs = this.hasRemainingPairs();
    
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
    
    // 如果有UI回调，调用它
    if (this.uiCallback) {
      try {
        this.uiCallback(type, message);
      } catch (error) {
        console.error('调用UI回调失败:', error);
      }
    }
  }

    // 添加设置UI回调的方法
    setUICallback(callback) {
      this.uiCallback = callback;
      console.log('[GameBoard] UI回调已设置');
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

    // GameBoard.js - 修改summonPokemonWithoutBallConsume方法
    summonPokemonWithoutBallConsume() {
        // 确保pendingRewards存在
        if (!this.pendingRewards) {
            this.pendingRewards = [];
        }
        const emptySlots = [];
        this.grid.forEach((cell, index) => {
            if (cell === null) emptySlots.push(index);
        });
        
        if (emptySlots.length === 0) {
            this.logGameEvent('错误', '场地已满！');
            return null;
        }
        
        const targetIndex = emptySlots[Math.floor(Math.random() * emptySlots.length)];
        const summonedPokemon = this.summonSystem.summonPokemon(targetIndex);
        this.grid[targetIndex] = summonedPokemon;
        
        let summonMessage = `召唤了${summonedPokemon.data.name}`;
        if (summonedPokemon.isShiny) summonMessage += ' (异色✨)';
        if (summonedPokemon.data.isLegendary) summonMessage += ' (传说🌟)';
        if (summonedPokemon.data.isMythical) summonMessage += ' (幻之💫)';
        if (summonedPokemon.data.isTransformer) summonMessage += ' (变身者🌀)';
        
        this.logGameEvent('召唤', summonMessage);
        
        // 处理特殊奖励
        const specialRewards = this.processSpecialRewards(summonedPokemon, targetIndex);
        if (specialRewards.balls > 0) {
            specialRewards.rewards.forEach(reward => {
                this.logGameEvent('奖励', reward.message);
                this.pendingRewards = this.pendingRewards || [];
                this.pendingRewards.push({
                    balls: reward.balls,
                    triggerIndex: targetIndex,
                    message: reward.message,
                    type: 'special',
                    order: Date.now()
                });
            });
        }
        
        // 命定属性奖励
        const chosenTypeRewards = this.ruleEngine.checkChosenType();
        if (chosenTypeRewards.length > 0) {
            this.processImmediateRuleRewards(chosenTypeRewards, targetIndex);
        }
        
        // 关键修复：立即检查所有规则（对对碰、三连等）
        console.log('[规则] 立即检查所有规则');
        const allRuleRewards = this.ruleEngine.checkAllRules();
        if (allRuleRewards.length > 0) {
            console.log(`[规则] 发现 ${allRuleRewards.length} 个规则被触发`);
            this.processRuleRewards(allRuleRewards);
        } else {
            console.log('[规则] 没有规则被触发');
        }
        
        // 处理变身者
        if (summonedPokemon.data.isTransformer) {
            const transformInfo = this.prepareTransform(summonedPokemon, targetIndex);
            summonedPokemon.transformInfo = transformInfo;
        }
        
        return summonedPokemon;
    }

  // 批量召唤方法
  async summonAllBalls() {
    if (this.ballsRemaining <= 0) {
      this.logGameEvent('错误', '没有精灵球了！');
      return null;
    }
    
    this.logGameEvent('行动', `批量投放 ${this.ballsRemaining} 个精灵球`);
    
    const emptySlots = this.grid
      .map((cell, index) => cell === null ? index : -1)
      .filter(i => i !== -1);
    
    const maxSummons = Math.min(this.ballsRemaining, emptySlots.length);
    
    if (maxSummons === 0) {
      this.logGameEvent('错误', '场地已满！');
      return null;
    }
    
    const results = [];
    for (let i = 0; i < maxSummons; i++) {
      const targetIndex = emptySlots[i];
      this.ballsRemaining--;
      
      const summonedPokemon = this.summonSystem.summonPokemon(targetIndex);
      this.grid[targetIndex] = summonedPokemon;
      
      results.push({
        pokemon: summonedPokemon,
        index: targetIndex
      });
      
      this.logGameEvent('召唤', `${summonedPokemon.data.name} 出现了！`);
      
      // 处理特殊奖励
      const specialRewards = this.processSpecialRewards(summonedPokemon);
      if (specialRewards.balls > 0) {
        this.ballsRemaining += specialRewards.balls;
        this.totalBallsAdded += specialRewards.balls;
        this.logGameEvent('奖励', specialRewards.description);
      }
      
      // 处理变身者
      if (summonedPokemon.data.isTransformer) {
        this.handleTransformer(summonedPokemon, targetIndex);
      }
    }
    
    // 批量召唤完成后检查规则
    const ruleRewards = this.ruleEngine.checkAllRules();
    this.processRuleRewards(ruleRewards);
    
    // 批量召唤完成后检查进化
    const evolutionEvents = this.evolutionManager.checkEvolutions();
    this.processEvolutionEvents(evolutionEvents);
    
    return results;
  }
}

export default GameBoard;