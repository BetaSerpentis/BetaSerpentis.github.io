// main.js - 修复版本
import PokemonData from './core/PokemonData.js';
import GameBoard from './core/GameBoard.js';
import ImageLoader from './utils/ImageLoader.js';
import AnimationManager from './utils/AnimationManager.js';
import PokemonCell from './ui/PokemonCell.js';
import BallCounter from './ui/BallCounter.js';
import MessageBoard from './ui/MessageBoard.js';

class VisualGame {
    constructor() {
        this.pokemonData = new PokemonData();
        this.gameBoard = null;
        this.imageLoader = new ImageLoader();
        
        this.gridCells = [];
        this.ballCounter = null;
        this.messageBoard = null;
        
        this.isSummoning = false;
        this.isGameOver = false;
        
        this.initUI();
        this.loadGame();
    }

    // main.js - 在loadGame方法中预加载精灵球图片
    async loadGame() {
        this.logMessage('系统', '正在加载宝可梦数据...');
        
        try {
            const loaded = await this.pokemonData.loadData('./data/pokemon_config.json');
            if (!loaded) {
                this.logMessage('错误', '无法加载宝可梦数据');
                return;
            }
            
            // 预加载精灵球图片
            await this.imageLoader.loadBallImage();
            console.log('[加载] 精灵球图片预加载完成');
            
            const allTypes = this.pokemonData.getAllTypes();
            
            this.selectedType = allTypes[0];
            this.selectedTypeColor = this.pokemonData.typeColors?.[allTypes[0]] || '#A8A878';
            
            if (this.typeSelectBtn) {
                this.typeSelectBtn.textContent = `✨ 命定属性：${this.selectedType}`;
                this.typeSelectBtn.style.background = `linear-gradient(45deg, ${this.selectedTypeColor}, ${this.lightenColor(this.selectedTypeColor, 20)})`;
            }
            
            this.gameBoard = new GameBoard(
                this.pokemonData, 
                this.selectedType, 
                9,
                (type, message) => this.immediateLogMessage(type, message)
            );
            
            this.gameBoard.playerChosenType = this.selectedType;
            
            this.gameBoard.setUICallback((type, message) => {
                this.immediateLogMessage(type, message);
            });
            
            this.gridCells.forEach(cell => {
                cell.typeColors = this.pokemonData.typeColors;
            });
            
            this.initializeGridCells();
            
            this.gameStarted = false;
            this.setGameStartState(false);
            
            this.logMessage('系统', '游戏准备就绪！请选择命定属性开始游戏');
            
        } catch (error) {
            this.logMessage('错误', `加载失败: ${error.message}`);
            console.error(error);
        }
    }

    // 修改summonPokemon方法，在召唤动画完成后处理奖励
    async summonPokemon() {
        if (!this.selectedType) {
            this.logMessage('错误', '请先选择命定属性！');
            return;
        }
        
        if (this.isSummoning || this.isGameOver) return;
        if (this.gameBoard.ballsRemaining <= 0) {
            this.logMessage('错误', '没有精灵球了！');
            return;
        }
        
        // 按下瞬间减球
        this.gameBoard.ballsRemaining--;
        this.updateBallCounter();
        this.logMessage('行动', `使用1个精灵球，剩余: ${this.gameBoard.ballsRemaining}`);
        
        if (!this.gameStarted) {
            this.setGameStartState(true);
            this.logMessage('系统', `游戏开始，命定属性已锁定为【${this.selectedType}】`);
        }
        
        this.isSummoning = true;
        console.log('=== 开始召唤 ===');
        
        try {
            const result = this.gameBoard.summonPokemonWithoutBallConsume();
            
            if (result) {
                const index = result.gridIndex;
                const cell = this.gridCells[index];
                
                console.log(`召唤宝可梦: ${result.data.name}, 格子 ${index}`);
                
                await this.imageLoader.loadPokemonImage(result.data.id);
                cell.setPokemon(result, this.imageLoader);
                
                // 播放召唤动画
                await this.playDirectSummonAnimation(cell, result);
                
                // 召唤动画完成后，处理所有待处理的奖励（包括特殊奖励、命定属性等）
                await this.processPendingRewards();
                
                // 检查是否为变身者
                if (result.data.isTransformer && result.transformInfo) {
                    console.log(`[变身流程] 开始变身动画`);
                    
                    await this.playTransformAnimation(cell, result.transformInfo);
                    
                    const transformedPokemon = this.gameBoard.executeTransform(result.transformInfo);
                    
                    if (transformedPokemon) {
                        await this.imageLoader.loadPokemonImage(transformedPokemon.data.id);
                        cell.setPokemon(transformedPokemon, this.imageLoader);
                        cell.updateDisplay();
                        
                        await this.delay(500);
                        
                        // 变身完成后处理可能的新奖励
                        await this.processPendingRewards();
                        await this.checkAndProcessTransformRules();
                    }
                }
                
                // 预加载所有场上宝可梦的图片
                await this.preloadAllPokemonImages();
                
                // 正常的同步
                setTimeout(async () => {
                    await this.syncGridWithGameBoard();
                }, 100);
                
                if (this.gameBoard.checkGameEnd()) {
                    this.gameOver();
                }
            }
        } catch (error) {
            console.error('召唤失败:', error);
            this.logMessage('错误', `召唤失败: ${error.message}`);
        }
        
        this.isSummoning = false;
        console.log('=== 召唤结束 ===');
    }

    // main.js - 修复checkAndProcessTransformRules方法
    async checkAndProcessTransformRules() {
        console.log(`[规则检查] 检查变身触发的规则`);
        
        await this.delay(100);
        
        const cellsToClear = [];
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (!gamePokemon && cellPokemon) {
                console.log(`[规则检查] 格子 ${i} 需要消除: ${cellPokemon.data.name}`);
                cellsToClear.push({ index: i, cell, pokemon: cellPokemon });
            }
        }
        
        if (cellsToClear.length > 0) {
            console.log(`[规则检查] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            // 先播放消失动画
            if (cellsToClear.length === 2) {
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell
                );
                // playPairEliminationAnimation内部已经处理了精灵球飞行
            } else if (cellsToClear.length === 3) {
                await this.playTripleEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell,
                    cellsToClear[2].cell
                );
                await this.playBallFlyAnimation(cellsToClear[0].cell);
            } else {
                for (const { cell } of cellsToClear) {
                    await this.playDisappearAnimation(cell);
                }
                if (cellsToClear.length > 0) {
                    await this.playBallFlyAnimation(cellsToClear[0].cell);
                }
            }
            
            this.updateBallCounter();
        }
    }

    async playTripleEliminationAnimation(cell1, cell2, cell3) {
        console.log(`[动画] 播放三连消除动画，格子 ${cell1.index}, ${cell2.index}, ${cell3.index}`);
        
        await Promise.all([
            this.playDisappearAnimation(cell1),
            this.playDisappearAnimation(cell2),
            this.playDisappearAnimation(cell3)
        ]);
        
        // 消除奖励已经在GameBoard.processRuleRewards中加入pendingRewards
        // 不需要在这里飞球
    }

    // 修改单个消除
    async playSingleEliminationAnimation(cell) {
        await this.playDisappearAnimation(cell);
        // 单个消除通常没有奖励，或者根据规则可能有
        await this.playBallFlyAnimation(cell, 1);
    }

    // main.js - 修改playTransformAnimation方法
    async playTransformAnimation(cell, transformInfo) {
        const { transformer, targetPokemon } = transformInfo;
        
        console.log(`[动画] 播放变身动画，格子 ${cell.index}: ${transformer.data.name} -> ${targetPokemon.data.name}`);
        
        await this.imageLoader.loadPokemonImage(targetPokemon.data.id);
        
        return new Promise((resolve) => {
            const duration = 1000;
            const startTime = performance.now();
            
            const targetSprite = this.imageLoader.getPokemonSprite(
                targetPokemon.data.id,
                transformer.isShiny,
                false
            );
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                cell.ctx.clearRect(0, 0, cell.size, cell.size);
                
                if (progress < 0.3) {
                    cell.updateDisplay();
                } else if (progress < 0.5) {
                    cell.ctx.save();
                    const blurAmount = (progress - 0.3) / 0.2 * 5;
                    cell.ctx.filter = `blur(${blurAmount}px)`;
                    if (cell.sprite) {
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(cell.sprite.width, cell.sprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            cell.sprite,
                            -cell.sprite.width / 2,
                            -cell.sprite.height / 2
                        );
                        cell.ctx.restore();
                    }
                    cell.ctx.restore();
                } else if (progress < 0.7) {
                    cell.ctx.save();
                    const distortion = Math.sin((progress - 0.5) / 0.2 * Math.PI) * 0.3;
                    cell.ctx.transform(1 + distortion, 0, 0, 1 - distortion, 0, 0);
                    
                    // 混合显示
                    if (cell.sprite) {
                        cell.ctx.globalAlpha = 0.5;
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(cell.sprite.width, cell.sprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            cell.sprite,
                            -cell.sprite.width / 2,
                            -cell.sprite.height / 2
                        );
                        cell.ctx.restore();
                    }
                    
                    if (targetSprite) {
                        cell.ctx.globalAlpha = 0.5;
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(targetSprite.width, targetSprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            targetSprite,
                            -targetSprite.width / 2,
                            -targetSprite.height / 2
                        );
                        cell.ctx.restore();
                    }
                    
                    cell.ctx.restore();
                } else if (progress < 0.9) {
                    const targetAlpha = (progress - 0.7) / 0.2;
                    
                    if (targetPokemon.currentTypes && targetPokemon.currentTypes[0]) {
                        const mainType = targetPokemon.currentTypes[0];
                        const typeColor = cell.typeColors[mainType] || '#A8A878';
                        
                        cell.ctx.fillStyle = `${typeColor}66`;
                        cell.ctx.globalAlpha = targetAlpha * 0.4;
                        cell.ctx.fillRect(0, 0, cell.size, cell.size);
                        
                        cell.ctx.strokeStyle = typeColor;
                        cell.ctx.lineWidth = 3;
                        cell.ctx.globalAlpha = targetAlpha;
                        cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
                    }
                    
                    if (targetSprite) {
                        cell.ctx.globalAlpha = targetAlpha;
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(targetSprite.width, targetSprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            targetSprite,
                            -targetSprite.width / 2,
                            -targetSprite.height / 2
                        );
                        cell.ctx.restore();
                    }
                    
                    cell.ctx.globalAlpha = 1.0;
                } else {
                    if (targetPokemon.currentTypes && targetPokemon.currentTypes[0]) {
                        const mainType = targetPokemon.currentTypes[0];
                        const typeColor = cell.typeColors[mainType] || '#A8A878';
                        
                        cell.ctx.fillStyle = `${typeColor}66`;
                        cell.ctx.fillRect(0, 0, cell.size, cell.size);
                        
                        cell.ctx.strokeStyle = typeColor;
                        cell.ctx.lineWidth = 3;
                        cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
                    }
                    
                    if (targetSprite) {
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(targetSprite.width, targetSprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            targetSprite,
                            -targetSprite.width / 2,
                            -targetSprite.height / 2
                        );
                        cell.ctx.restore();
                    }
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    resolve();
                }
            };
            
            animate();
        });
    }

    // main.js - 修改syncGridWithGameBoard方法
    async syncGridWithGameBoard() {
        console.log('[同步] ========== 开始同步 ==========');
        
        if (!this.gameBoard) return;
        
        // 等待一下，确保所有动画完成
        await this.delay(200);
        
        // 检查是否有进化事件
        const hasEvolution = await this.checkAndProcessEvolutions();
        
        if (hasEvolution) {
            await this.delay(800);
        }
        
        // 同步所有格子状态（排除已经在动画中处理过的）
        const cellsToClear = [];
        const cellsToAdd = [];
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            // 如果格子已经被清除（pokemon为null），跳过
            if (!cell.isActive) continue;
            
            if (!gamePokemon && cellPokemon) {
                cellsToClear.push({ index: i, cell, pokemon: cellPokemon });
            } else if (gamePokemon && !cellPokemon) {
                cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
            } else if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                // 如果是变身，跳过（已经在动画中处理了）
                if (!gamePokemon.data.isTransformer || !cellPokemon.data.isTransformer) {
                    cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
                }
            }
        }
        
        // main.js - 修改syncGridWithGameBoard中的消除处理
        if (cellsToClear.length > 0) {
            console.log(`[同步] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            if (cellsToClear.length === 2) {
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell
                );
            } else if (cellsToClear.length === 3) {
                await this.playTripleEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell,
                    cellsToClear[2].cell
                );
            } else {
                for (const { cell } of cellsToClear) {
                    await this.playDisappearAnimation(cell);
                }
            }
        }
        
        // 处理添加/更新
        if (cellsToAdd.length > 0) {
            console.log(`[同步] 发现 ${cellsToAdd.length} 个格子需要更新`);
            for (const { cell, pokemon } of cellsToAdd) {
                await this.imageLoader.loadPokemonImage(pokemon.data.id);
                cell.setPokemon(pokemon, this.imageLoader);
                cell.updateDisplay();
            }
        }
        
        // 更新球计数器
        this.updateBallCounter();
        
        console.log('[同步] 同步完成');
    }

    // main.js - 修改checkAndProcessEvolutions
    async checkAndProcessEvolutions() {
        let hasEvolution = false;
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                if (this.isEvolution(cellPokemon, gamePokemon)) {
                    console.log(`[进化检测] 发现进化: 格子 ${i}, ${cellPokemon.data.name} -> ${gamePokemon.data.name}`);
                    
                    await this.imageLoader.loadPokemonImage(gamePokemon.data.id);
                    
                    // 播放进化动画
                    await this.playEvolutionAnimation(cell, gamePokemon);
                    
                    hasEvolution = true;
                    
                    // 进化完成后处理奖励
                    await this.processPendingRewards();
                }
            }
        }
        
        return hasEvolution;
    }

    isEvolution(oldPokemon, newPokemon) {
        if (!oldPokemon || !newPokemon) return false;
        
        // 方法1：检查进化链（如果你有数据）
        if (oldPokemon.data.evolvesTo === newPokemon.data.id) {
            return true;
        }
    }

    // 新增：预加载所有场上宝可梦图片
    async preloadAllPokemonImages() {
        if (!this.gameBoard) return;
        
        console.log('[预加载] 开始预加载所有场上宝可梦图片');
        
        const loadPromises = [];
        
        for (let i = 0; i < 9; i++) {
            const pokemon = this.gameBoard.grid[i];
            if (pokemon) {
                console.log(`[预加载] 预加载宝可梦: ${pokemon.data.name} (ID: ${pokemon.data.id})`);
                loadPromises.push(this.imageLoader.loadPokemonImage(pokemon.data.id));
            }
        }
        
        try {
            await Promise.all(loadPromises);
            console.log('[预加载] 所有宝可梦图片预加载完成');
        } catch (error) {
            console.error('[预加载] 预加载图片失败:', error);
        }
    }

    // 在main.js中修改相关方法，确保图片正确加载
    async playEvolutionAnimation(cell, newPokemon) {
        console.log(`[动画] 播放进化动画，格子 ${cell.index}: ${cell.pokemon?.data?.name} -> ${newPokemon.data.name}`);
        
        return new Promise(async (resolve) => {
            // 确保新宝可梦图片已加载
            console.log(`[动画] 预加载新宝可梦图片: ${newPokemon.data.id}`);
            await this.imageLoader.loadPokemonImage(newPokemon.data.id);
            
            const newSprite = this.imageLoader.getPokemonSprite(
                newPokemon.data.id,
                newPokemon.isShiny,
                false
            );
            
            if (!newSprite) {
                console.error(`[动画] 无法获取新宝可梦精灵: ${newPokemon.data.id}`);
                // 回退：直接设置宝可梦
                cell.setPokemon(newPokemon, this.imageLoader);
                cell.updateDisplay();
                resolve();
                return;
            }
            
            const duration = 1200;
            const startTime = performance.now();
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // 清空画布
                cell.ctx.clearRect(0, 0, cell.size, cell.size);
                
                if (progress < 0.3) {
                    // 第一阶段：原宝可梦闪烁
                    if (Math.floor(progress * 20) % 2 === 0) {
                        // 显示原宝可梦
                        cell.updateDisplay();
                    } else {
                        // 白色闪光
                        cell.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                        cell.ctx.fillRect(0, 0, cell.size, cell.size);
                    }
                } else if (progress < 0.6) {
                    // 第二阶段：强烈白光
                    const intensity = 0.8 - ((progress - 0.3) / 0.3) * 0.8;
                    cell.ctx.fillStyle = `rgba(255, 255, 255, ${intensity})`;
                    cell.ctx.fillRect(0, 0, cell.size, cell.size);
                    
                    // 绘制原宝可梦的轮廓
                    if (cell.sprite) {
                        cell.ctx.globalAlpha = 0.3;
                        cell.ctx.drawImage(
                            cell.sprite,
                            (cell.size - cell.sprite.width) / 2,
                            (cell.size - cell.sprite.height) / 2
                        );
                        cell.ctx.globalAlpha = 1.0;
                    }
                } else if (progress < 0.8) {
                    // 第三阶段：白光减弱，新宝可梦逐渐显现
                    const whiteIntensity = 0.8 - ((progress - 0.6) / 0.2) * 0.8;
                    cell.ctx.fillStyle = `rgba(255, 255, 255, ${whiteIntensity})`;
                    cell.ctx.fillRect(0, 0, cell.size, cell.size);
                    
                    // 绘制新宝可梦（从透明到不透明）
                    if (newSprite) {
                        const newAlpha = ((progress - 0.6) / 0.2);
                        cell.ctx.globalAlpha = newAlpha;
                        
                        // 绘制新宝可梦的背景
                        if (newPokemon.currentTypes && newPokemon.currentTypes[0]) {
                            const mainType = newPokemon.currentTypes[0];
                            const typeColor = cell.typeColors[mainType] || '#A8A878';
                            cell.ctx.fillStyle = `${typeColor}66`;
                            cell.ctx.globalAlpha = newAlpha * 0.4;
                            cell.ctx.fillRect(0, 0, cell.size, cell.size);
                            
                            cell.ctx.strokeStyle = typeColor;
                            cell.ctx.lineWidth = 3;
                            cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
                            cell.ctx.globalAlpha = newAlpha;
                        }
                        
                        cell.ctx.drawImage(
                            newSprite,
                            (cell.size - newSprite.width) / 2,
                            (cell.size - newSprite.height) / 2
                        );
                        cell.ctx.globalAlpha = 1.0;
                    }
                } else {
                    // 第四阶段：最终显示
                    // 设置新宝可梦数据
                    cell.pokemon = newPokemon;
                    cell.sprite = newSprite;
                    cell.updateDisplay();
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    // 动画完成，确保最终状态正确
                    cell.pokemon = newPokemon;
                    cell.sprite = newSprite;
                    cell.updateDisplay();
                    
                    // 如果是异色宝可梦，播放闪光特效
                    if (newPokemon.isShiny) {
                        setTimeout(() => {
                            this.playShinyEffect(cell, resolve);
                        }, 300);
                    } else {
                        resolve();
                    }
                }
            };
            
            animate();
        });
    }

    // main.js - 平滑消失动画版本
    async playDisappearAnimation(cell) {
        console.log(`[动画] 播放消失动画，格子 ${cell.index}`);
        
        return new Promise((resolve) => {
            const duration = 350;
            const startTime = performance.now();
            
            // 保存原始精灵和宝可梦数据
            const originalPokemon = cell.pokemon;
            const originalSprite = cell.sprite;
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // 清空画布
                cell.ctx.clearRect(0, 0, cell.size, cell.size);
                
                // 先绘制空格子背景作为底层
                cell.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
                cell.ctx.fillRect(0, 0, cell.size, cell.size);
                
                cell.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
                cell.ctx.lineWidth = 2;
                cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
                
                // 在上面绘制宝可梦，并让它淡出
                if (originalSprite) {
                    // 缩放从1到0.2
                    const scale = 1 - progress * 0.8;
                    // 透明度从0.9到0（比背景稍亮）
                    const alpha = 0.9 * (1 - progress);
                    
                    const maxSize = cell.size * 0.7;
                    const baseScale = maxSize / Math.max(originalSprite.width, originalSprite.height);
                    
                    cell.ctx.save();
                    cell.ctx.translate(cell.size / 2, cell.size / 2);
                    cell.ctx.scale(scale * baseScale, scale * baseScale);
                    cell.ctx.globalAlpha = alpha;
                    cell.ctx.drawImage(
                        originalSprite,
                        -originalSprite.width / 2,
                        -originalSprite.height / 2
                    );
                    cell.ctx.restore();
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    // 动画完成，完全清除格子
                    cell.clear();
                    resolve();
                }
            };
            
            animate();
        });
    }

    // 修改消除动画，不再直接飞球
    async playPairEliminationAnimation(cell1, cell2) {
        console.log(`[动画] 播放对对碰消除动画，格子 ${cell1.index} 和 ${cell2.index}`);
        
        await Promise.all([
            this.playDisappearAnimation(cell1),
            this.playDisappearAnimation(cell2)
        ]);
        
        // 消除奖励已经在GameBoard.processRuleRewards中加入pendingRewards
        // 不需要在这里飞球
    }

    // main.js - 修改syncGridWithGameBoard，确保能检测到消除
    async syncGridWithGameBoard() {
        console.log('[同步] ========== 开始同步 ==========');
        
        if (!this.gameBoard) return;
        
        // 打印当前游戏板状态
        console.log('[同步] 当前游戏板状态:');
        const gridState = this.gameBoard.grid.map((p, i) => 
            `${i}:${p?.data?.name || '空'}`
        ).join(' ');
        console.log(`[同步] ${gridState}`);
        
        await this.delay(200);
        
        // 检查进化
        const hasEvolution = await this.checkAndProcessEvolutions();
        if (hasEvolution) {
            await this.delay(800);
            await this.processPendingRewards();
        }
        
        // 找出需要消除的格子
        const cellsToClear = [];
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (!cell.isActive) continue;
            
            if (!gamePokemon && cellPokemon) {
                console.log(`[同步] 格子 ${i} 需要消除: ${cellPokemon.data.name}`);
                cellsToClear.push({ index: i, cell, pokemon: cellPokemon });
            }
        }
        
        // 消除宝可梦
        if (cellsToClear.length > 0) {
            console.log(`[同步] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            if (cellsToClear.length === 2) {
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell
                );
            } else if (cellsToClear.length === 3) {
                await this.playTripleEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell,
                    cellsToClear[2].cell
                );
            } else {
                for (const { cell } of cellsToClear) {
                    await this.playDisappearAnimation(cell);
                }
            }
            
            // 消除后处理奖励
            await this.processPendingRewards();
        } else {
            console.log('[同步] 没有格子需要消除');
        }
        
        this.updateBallCounter();
        
        console.log('[同步] 同步完成');
    }

    // main.js - 修改playDirectSummonAnimation方法
    async playDirectSummonAnimation(cell, pokemonInstance) {
        const ballImage = await this.imageLoader.loadBallImage();
        
        console.log(`播放召唤动画，格子 ${cell.index}`);
        
        return new Promise((resolve) => {
            // 获取格子中心位置
            const centerPos = cell.getCenterPosition();
            
            // 精灵球起始位置（屏幕底部中间）
            const startX = window.innerWidth / 2;
            const startY = window.innerHeight - 50;
            
            // 目标位置是格子中心
            const endX = centerPos.x;
            const endY = centerPos.y;
            
            // 获取格子canvas的上下文
            const ctx = cell.ctx;
            const canvasWidth = cell.size;
            const canvasHeight = cell.size;
            
            const duration = 800;
            const startTime = performance.now();
            const ballScale = 1.5;
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // 贝塞尔曲线计算
                const controlX = (startX + endX) / 2;
                const controlY = Math.min(startY, endY) - 100;
                
                const x = Math.pow(1 - progress, 2) * startX +
                        2 * (1 - progress) * progress * controlX +
                        Math.pow(progress, 2) * endX;
                
                const y = Math.pow(1 - progress, 2) * startY +
                        2 * (1 - progress) * progress * controlY +
                        Math.pow(progress, 2) * endY;
                
                const rotation = progress * 720;
                
                // 计算相对于canvas的坐标
                const canvasX = x - (endX - canvasWidth / 2);
                const canvasY = y - (endY - canvasHeight / 2);
                
                ctx.clearRect(0, 0, canvasWidth, canvasHeight);
                ctx.save();
                ctx.translate(canvasX, canvasY);
                ctx.rotate(rotation * Math.PI / 180);
                
                ctx.drawImage(
                    ballImage,
                    -ballImage.width * ballScale / 2,
                    -ballImage.height * ballScale / 2,
                    ballImage.width * ballScale,
                    ballImage.height * ballScale
                );
                ctx.restore();
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
                    this.playPokemonAppearAnimation(cell, resolve);
                }
            };
            
            animate();
        });
    }

    // 抛物线动画
    playParabolaAnimation(cell, ballImage, onComplete) {
        const startX = cell.x + cell.size / 2;
        const startY = window.innerHeight - 100;
        const endX = cell.x + cell.size / 2;
        const endY = cell.y + cell.size / 2;
        
        const duration = 800;
        const startTime = performance.now();
        const ballScale = 1.5;
        
        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 贝塞尔曲线计算
            const controlX = (startX + endX) / 2;
            const controlY = Math.min(startY, endY) - 100;
            
            const x = 
                Math.pow(1 - progress, 2) * startX +
                2 * (1 - progress) * progress * controlX +
                Math.pow(progress, 2) * endX;
            
            const y = 
                Math.pow(1 - progress, 2) * startY +
                2 * (1 - progress) * progress * controlY +
                Math.pow(progress, 2) * endY;
            
            // 旋转角度
            const rotation = progress * 720;
            
            // 绘制精灵球
            cell.ctx.clearRect(0, 0, cell.size, cell.size);
            cell.ctx.save();
            cell.ctx.translate(x - cell.x, y - cell.y);
            cell.ctx.rotate(rotation * Math.PI / 180);
            
            cell.ctx.drawImage(
                ballImage,
                -ballImage.width * ballScale / 2,
                -ballImage.height * ballScale / 2,
                ballImage.width * ballScale,
                ballImage.height * ballScale
            );
            cell.ctx.restore();
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // 动画完成
                cell.ctx.clearRect(0, 0, cell.size, cell.size);
                if (onComplete) onComplete();
            }
        };
        
        animate();
    }

    // 修改宝可梦出现动画
    playPokemonAppearAnimation(cell, onComplete) {
        const duration = 500;
        const startTime = performance.now();
        
        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            const scale = 0.1 + (0.9 * progress);
            
            cell.ctx.clearRect(0, 0, cell.size, cell.size);
            
            // 绘制背景
            if (cell.pokemon && cell.pokemon.currentTypes && cell.pokemon.currentTypes[0]) {
                const mainType = cell.pokemon.currentTypes[0];
                const typeColor = cell.typeColors[mainType] || '#A8A878';
                
                cell.ctx.fillStyle = `${typeColor}66`;
                cell.ctx.fillRect(0, 0, cell.size, cell.size);
                
                cell.ctx.strokeStyle = typeColor;
                cell.ctx.lineWidth = 3;
                cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
            }
            
            // 绘制宝可梦
            if (cell.sprite) {
                const maxSize = cell.size * 0.7;
                const baseScale = maxSize / Math.max(cell.sprite.width, cell.sprite.height);
                
                cell.ctx.save();
                cell.ctx.translate(cell.size / 2, cell.size / 2);
                cell.ctx.scale(scale * baseScale, scale * baseScale);
                cell.ctx.drawImage(
                    cell.sprite,
                    -cell.sprite.width / 2,
                    -cell.sprite.height / 2
                );
                cell.ctx.restore();
            }
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                cell.updateDisplay();
                if (onComplete) onComplete();
            }
        };
        
        animate();
    }

    // 修改现有的playShinyEffect方法，确保它可以被复用
    playShinyEffect(cell, onComplete) {
        console.log(`[动画] 播放异色特效，格子 ${cell.index}`);
        
        const stars = [];
        for (let i = 0; i < 6; i++) {
            stars.push({
                angle: (i * Math.PI * 2) / 6,
                distance: 0,
                scale: 0
            });
        }
        
        const duration = 1000;
        const startTime = performance.now();
        
        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 清空并重新绘制宝可梦
            cell.ctx.clearRect(0, 0, cell.size, cell.size);
            cell.updateDisplay();
            
            // 绘制星星
            stars.forEach(star => {
                star.distance = progress * 50;
                star.scale = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
                
                const x = cell.size / 2 + Math.cos(star.angle) * star.distance;
                const y = cell.size / 2 + Math.sin(star.angle) * star.distance;
                
                cell.ctx.save();
                cell.ctx.translate(x, y);
                cell.ctx.scale(star.scale, star.scale);
                
                cell.ctx.fillStyle = 'gold';
                cell.ctx.beginPath();
                
                // 绘制五角星
                for (let i = 0; i < 5; i++) {
                    const outerAngle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
                    const innerAngle = outerAngle + Math.PI / 5;
                    
                    const outerX = 10 * Math.cos(outerAngle);
                    const outerY = 10 * Math.sin(outerAngle);
                    
                    const innerX = 5 * Math.cos(innerAngle);
                    const innerY = 5 * Math.sin(innerAngle);
                    
                    if (i === 0) {
                        cell.ctx.moveTo(outerX, outerY);
                    } else {
                        cell.ctx.lineTo(outerX, outerY);
                    }
                    
                    cell.ctx.lineTo(innerX, innerY);
                }
                
                cell.ctx.closePath();
                cell.ctx.fill();
                cell.ctx.restore();
            });
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // 特效完成
                cell.updateDisplay();
                if (onComplete) onComplete();
            }
        };
        
        animate();
    }

    // 修改updateBallCounter方法，更新新的计数显示
    updateBallCounter() {
        if (!this.gameBoard) return;
        
        // 更新精灵球数量显示
        if (this.ballCountSpan) {
            this.ballCountSpan.textContent = this.gameBoard.ballsRemaining;
        }
        
        // 更新累计获得显示
        if (this.totalBallsSpan) {
            this.totalBallsSpan.textContent = this.gameBoard.totalBallsAdded;
        }
    }

    // main.js - 修改initUI方法，适配PWA全屏
    initUI() {
        // 设置页面样式 - 使用fixed定位防止滚动
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        document.body.style.height = '100%';
        document.body.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        
        // 创建游戏容器 - 使用env()适配刘海屏
        const container = document.createElement('div');
        container.id = 'game-container';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.position = 'relative';
        container.style.maxWidth = '500px';
        container.style.margin = '0 auto';
        container.style.background = 'rgba(0, 0, 0, 0.2)';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.padding = 'env(safe-area-inset-top, 15px) 15px env(safe-area-inset-bottom, 15px) 15px';
        container.style.boxSizing = 'border-box';
        container.style.overflowY = 'auto';
        container.style.overflowX = 'hidden';
        container.style.WebkitOverflowScrolling = 'touch'; // iOS平滑滚动
        document.body.appendChild(container);
        
        this.container = container;

        // 标题
        const title = document.createElement('div');
        title.textContent = '宝可梦对对碰';
        title.style.textAlign = 'center';
        title.style.color = '#FFD700';
        title.style.fontSize = '26px';
        title.style.fontWeight = 'bold';
        title.style.padding = '15px 0 10px 0';
        title.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
        title.style.letterSpacing = '2px';
        container.appendChild(title);
        
        // 信息栏
        const infoBar = document.createElement('div');
        infoBar.style.width = '100%';
        infoBar.style.maxWidth = '400px';
        infoBar.style.margin = '0 auto 15px auto';
        infoBar.style.padding = '15px 20px';
        infoBar.style.background = 'rgba(0, 0, 0, 0.5)';
        infoBar.style.borderRadius = '15px';
        infoBar.style.boxSizing = 'border-box';
        infoBar.style.backdropFilter = 'blur(5px)';
        infoBar.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        container.appendChild(infoBar);
        
        // 精灵球数量
        const ballRow = document.createElement('div');
        ballRow.style.display = 'flex';
        ballRow.style.alignItems = 'center';
        ballRow.style.marginBottom = '8px';
        infoBar.appendChild(ballRow);
        
        const ballIcon = document.createElement('span');
        ballIcon.textContent = '⚽';
        ballIcon.style.fontSize = '24px';
        ballIcon.style.marginRight = '10px';
        ballIcon.style.color = '#FF4444';
        ballRow.appendChild(ballIcon);
        
        const ballLabel = document.createElement('span');
        ballLabel.textContent = '精灵球：';
        ballLabel.style.color = 'white';
        ballLabel.style.fontSize = '16px';
        ballLabel.style.fontWeight = '500';
        ballRow.appendChild(ballLabel);
        
        this.ballCountSpan = document.createElement('span');
        this.ballCountSpan.textContent = '9';
        this.ballCountSpan.style.color = '#FFD700';
        this.ballCountSpan.style.fontSize = '20px';
        this.ballCountSpan.style.fontWeight = 'bold';
        this.ballCountSpan.style.marginLeft = '5px';
        ballRow.appendChild(this.ballCountSpan);
        
        // 累计捕获
        const captureRow = document.createElement('div');
        captureRow.style.display = 'flex';
        captureRow.style.alignItems = 'center';
        infoBar.appendChild(captureRow);
        
        const captureIcon = document.createElement('span');
        captureIcon.textContent = '🏆';
        captureIcon.style.fontSize = '20px';
        captureIcon.style.marginRight = '10px';
        captureIcon.style.color = '#FFD700';
        captureRow.appendChild(captureIcon);
        
        const captureLabel = document.createElement('span');
        captureLabel.textContent = '累计获得：';
        captureLabel.style.color = 'white';
        captureLabel.style.fontSize = '15px';
        captureLabel.style.fontWeight = '500';
        captureRow.appendChild(captureLabel);
        
        this.totalBallsSpan = document.createElement('span');
        this.totalBallsSpan.textContent = '0';
        this.totalBallsSpan.style.color = '#81C784';
        this.totalBallsSpan.style.fontSize = '18px';
        this.totalBallsSpan.style.fontWeight = 'bold';
        this.totalBallsSpan.style.marginLeft = '5px';
        captureRow.appendChild(this.totalBallsSpan);
        
        // 九宫格场地
        this.createGameGrid();
        
        // 命定属性栏
        const typeBar = document.createElement('div');
        typeBar.style.width = '100%';
        typeBar.style.maxWidth = '400px';
        typeBar.style.margin = '15px auto';
        typeBar.style.display = 'flex';
        typeBar.style.justifyContent = 'center';
        typeBar.style.alignItems = 'center';
        container.appendChild(typeBar);
        
        this.typeSelectBtn = this.createTypeSelectButton();
        typeBar.appendChild(this.typeSelectBtn);
        
        // 游戏日志
        const logContainer = document.createElement('div');
        logContainer.style.width = '100%';
        logContainer.style.maxWidth = '400px';
        logContainer.style.margin = '0 auto';
        logContainer.style.flex = '1';
        logContainer.style.minHeight = '0';
        logContainer.style.display = 'flex';
        logContainer.style.flexDirection = 'column';
        container.appendChild(logContainer);
        
        const logTitle = document.createElement('div');
        logTitle.textContent = '📋 游戏日志';
        logTitle.style.color = '#FFD700';
        logTitle.style.fontSize = '16px';
        logTitle.style.fontWeight = 'bold';
        logTitle.style.marginBottom = '5px';
        logTitle.style.paddingLeft = '5px';
        logContainer.appendChild(logTitle);
        
        this.messageBoard = new MessageBoard(0, 0, 400, 140);
        const messageElement = this.messageBoard.getElement();
        messageElement.style.position = 'relative';
        messageElement.style.width = '100%';
        messageElement.style.height = '140px';
        messageElement.style.left = '0';
        messageElement.style.top = '0';
        messageElement.style.background = 'rgba(0, 0, 0, 0.7)';
        messageElement.style.borderRadius = '12px';
        messageElement.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        messageElement.style.backdropFilter = 'blur(5px)';
        logContainer.appendChild(messageElement);
        
        // 操作按钮
        const buttonBar = document.createElement('div');
        buttonBar.style.width = '100%';
        buttonBar.style.maxWidth = '400px';
        buttonBar.style.margin = '15px auto';
        buttonBar.style.display = 'flex';
        buttonBar.style.justifyContent = 'center';
        buttonBar.style.gap = '20px';
        buttonBar.style.padding = '0 10px';
        buttonBar.style.boxSizing = 'border-box';
        container.appendChild(buttonBar);
        
        const throwBtn = this.createButton('🎯 扔球', () => this.summonPokemon());
        throwBtn.style.flex = '1';
        throwBtn.style.maxWidth = '160px';
        throwBtn.style.background = 'linear-gradient(45deg, #2196F3, #21CBF3)';
        buttonBar.appendChild(throwBtn);
        
        const restartBtn = this.createButton('🔄 重新开始', () => this.restartGame());
        restartBtn.style.flex = '1';
        restartBtn.style.maxWidth = '160px';
        restartBtn.style.background = 'linear-gradient(45deg, #FF6B6B, #FF8E8E)';
        buttonBar.appendChild(restartBtn);
        
        this.throwBtn = throwBtn;
        this.restartBtn = restartBtn;
        
        this.setGameStartState(false);
    }

    // main.js - 简化createGameGrid方法，使用CSS Grid布局
    createGameGrid() {
        const container = this.container;
        
        // 创建九宫格外容器 - 使用CSS Grid布局
        const gridWrapper = document.createElement('div');
        gridWrapper.style.width = '100%';
        gridWrapper.style.maxWidth = '400px';
        gridWrapper.style.margin = '0 auto';
        gridWrapper.style.aspectRatio = '1 / 1';
        gridWrapper.style.display = 'grid';
        gridWrapper.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridWrapper.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridWrapper.style.gap = '5px';
        gridWrapper.style.padding = '5px';
        gridWrapper.style.boxSizing = 'border-box';
        gridWrapper.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        gridWrapper.style.borderRadius = '15px';
        gridWrapper.style.border = '2px solid rgba(255, 255, 255, 0.2)';
        gridWrapper.style.backdropFilter = 'blur(5px)';
        container.appendChild(gridWrapper);
        
        this.gridWrapper = gridWrapper;
        
        // 创建9个格子
        this.gridCells = [];
        
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                const index = row * 3 + col;
                
                // 创建格子容器
                const cellContainer = document.createElement('div');
                cellContainer.style.width = '100%';
                cellContainer.style.height = '100%';
                cellContainer.style.display = 'flex';
                cellContainer.style.justifyContent = 'center';
                cellContainer.style.alignItems = 'center';
                cellContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                cellContainer.style.borderRadius = '10px';
                cellContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
                gridWrapper.appendChild(cellContainer);
                
                // 获取格子实际大小
                setTimeout(() => {
                    const rect = cellContainer.getBoundingClientRect();
                    const cellSize = Math.min(rect.width, rect.height);
                    
                    // 创建PokemonCell
                    const cell = new PokemonCell(index, cellContainer, cellSize);
                    this.gridCells.push(cell);
                    
                    // 初始化显示
                    cell.updateDisplay();
                }, 0);
            }
        }
        
        // 监听窗口大小变化，更新格子大小
        window.addEventListener('resize', () => {
            setTimeout(() => {
                this.gridCells.forEach((cell, index) => {
                    const row = Math.floor(index / 3);
                    const col = index % 3;
                    const cellContainer = this.gridWrapper.children[row * 3 + col];
                    const rect = cellContainer.getBoundingClientRect();
                    const newSize = Math.min(rect.width, rect.height);
                    
                    cell.size = newSize;
                    cell.canvas.width = newSize;
                    cell.canvas.height = newSize;
                    cell.updateDisplay();
                });
            }, 100);
        });
    }

    // 在createControls方法中修改，添加属性选择按钮
    createControls() {
        const container = this.container;
        const controls = document.createElement('div');
        controls.style.position = 'absolute';
        controls.style.bottom = '20px';
        controls.style.left = '0';
        controls.style.right = '0';
        controls.style.display = 'flex';
        controls.style.flexDirection = 'column';
        controls.style.alignItems = 'center';
        controls.style.gap = '15px';
        controls.style.padding = '0 20px';
        container.appendChild(controls);
        
        // 命定属性选择行
        const typeRow = document.createElement('div');
        typeRow.style.display = 'flex';
        typeRow.style.justifyContent = 'center';
        typeRow.style.gap = '10px';
        typeRow.style.width = '100%';
        typeRow.style.marginBottom = '5px';
        controls.appendChild(typeRow);
        
        // 命定属性标签
        const typeLabel = document.createElement('span');
        typeLabel.textContent = '命定属性：';
        typeLabel.style.color = 'white';
        typeLabel.style.fontSize = '16px';
        typeLabel.style.fontWeight = 'bold';
        typeLabel.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
        typeLabel.style.padding = '10px 0';
        typeRow.appendChild(typeLabel);
        
        // 属性选择按钮
        this.typeSelectBtn = this.createTypeSelectButton();
        typeRow.appendChild(this.typeSelectBtn);
        
        // 游戏控制按钮行
        const buttonRow = document.createElement('div');
        buttonRow.style.display = 'flex';
        buttonRow.style.justifyContent = 'center';
        buttonRow.style.gap = '20px';
        buttonRow.style.width = '100%';
        controls.appendChild(buttonRow);
        
        // 扔球按钮
        const throwBtn = this.createButton('扔球', () => this.summonPokemon());
        buttonRow.appendChild(throwBtn);
        
        // 扔所有球按钮
        const throwAllBtn = this.createButton('扔所有球', () => this.summonAllBalls());
        buttonRow.appendChild(throwAllBtn);
        
        // 重新开始按钮
        const restartBtn = this.createButton('重新开始', () => this.restartGame());
        buttonRow.appendChild(restartBtn);
        
        // 保存按钮引用
        this.throwBtn = throwBtn;
        this.throwAllBtn = throwAllBtn;
        this.restartBtn = restartBtn;
        
        // 初始状态：游戏未开始，属性可选择
        this.setGameStartState(false);
    }

    // 新增：创建属性选择按钮
    createTypeSelectButton() {
        // 宝可梦属性列表
        const types = [
            { name: '草', color: '#c0d631' },
            { name: '水', color: '#9dd7f5' },
            { name: '火', color: '#f2a057' },
            { name: '雷', color: '#ffe26e' },
            { name: '恶', color: '#00586e' },
            { name: '斗', color: '#f7b816' },
            { name: '钢', color: '#d4d5d6' },
            { name: '龙', color: '#dbc051' },
            { name: '无', color: '#edeceb' },
            { name: '超', color: '#e3a1c5' },
        ];
        
        const button = document.createElement('button');
        button.textContent = this.selectedType ? `✨ 命定属性：${this.selectedType}` : '⚡ 点击选择命定属性';
        button.style.padding = '12px 25px';
        button.style.fontSize = '16px';
        button.style.fontWeight = 'bold';
        button.style.color = 'white';
        button.style.border = '2px solid white';
        button.style.borderRadius = '30px';
        button.style.cursor = 'pointer';
        button.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
        button.style.transition = 'transform 0.2s, box-shadow 0.2s';
        button.style.minWidth = '200px';
        button.style.letterSpacing = '1px';
        
        if (this.selectedType) {
            const typeColor = types.find(t => t.name === this.selectedType)?.color || '#757575';
            button.style.background = `linear-gradient(45deg, ${typeColor}, ${this.lightenColor(typeColor, 20)})`;
            button.style.boxShadow = `0 4px 15px ${typeColor}80`;
        } else {
            button.style.background = 'linear-gradient(45deg, #757575, #9E9E9E)';
        }
        
        button.addEventListener('mouseenter', () => {
            button.style.transform = 'translateY(-2px)';
            button.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.4)';
        });
        
        button.addEventListener('mouseleave', () => {
            button.style.transform = 'translateY(0)';
            if (this.selectedType) {
                const typeColor = types.find(t => t.name === this.selectedType)?.color || '#757575';
                button.style.boxShadow = `0 4px 15px ${typeColor}80`;
            } else {
                button.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
            }
        });
        
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTypeSelectionDialog(types, button);
        });
        
        return button;
    }

    // main.js - 修改showTypeSelectionDialog方法，优化竖屏显示
    showTypeSelectionDialog(types, buttonElement) {
        // 如果游戏已经开始，不能选择属性
        if (this.gameStarted) {
            this.logMessage('系统', '游戏已开始，不能更改命定属性');
            return;
        }
        
        console.log('[属性] 打开属性选择对话框');
        
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.zIndex = '2000';
        overlay.style.backdropFilter = 'blur(5px)';
        
        // 创建对话框 - 更适配竖屏
        const dialog = document.createElement('div');
        dialog.style.backgroundColor = 'rgba(30, 30, 40, 0.98)';
        dialog.style.borderRadius = '20px';
        dialog.style.padding = '20px 15px';
        dialog.style.maxWidth = '400px';
        dialog.style.width = '90%';
        dialog.style.maxHeight = '90vh';
        dialog.style.overflowY = 'auto'; // 允许滚动
        dialog.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
        dialog.style.border = '2px solid #FFD700';
        
        // 标题
        const title = document.createElement('h2');
        title.textContent = '选择命定属性';
        title.style.color = '#FFD700';
        title.style.textAlign = 'center';
        title.style.marginTop = '0';
        title.style.marginBottom = '10px';
        title.style.fontSize = '22px';
        title.style.fontWeight = 'bold';
        title.style.textShadow = '0 0 10px rgba(255,215,0,0.3)';
        dialog.appendChild(title);
        
        // 说明文字
        const desc = document.createElement('p');
        desc.textContent = '命定属性宝可梦出现时，会额外获得1个精灵球';
        desc.style.color = '#CCCCCC';
        desc.style.textAlign = 'center';
        desc.style.marginBottom = '15px';
        desc.style.fontSize = '13px';
        desc.style.padding = '0 5px';
        dialog.appendChild(desc);
        
        // 属性网格 - 修改为更适合竖屏的布局
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, 1fr)'; // 改为3列
        grid.style.gap = '8px';
        grid.style.marginBottom = '15px';
        dialog.appendChild(grid);
        
        // 添加属性按钮
        types.forEach(type => {
            const typeBtn = document.createElement('button');
            typeBtn.textContent = type.name;
            typeBtn.style.padding = '10px 5px';
            typeBtn.style.fontSize = '14px';
            typeBtn.style.fontWeight = 'bold';
            typeBtn.style.color = 'white';
            typeBtn.style.background = type.color;
            typeBtn.style.border = '2px solid rgba(255,255,255,0.3)';
            typeBtn.style.borderRadius = '12px';
            typeBtn.style.cursor = 'pointer';
            typeBtn.style.transition = 'transform 0.2s, border-color 0.2s, box-shadow 0.2s';
            typeBtn.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
            typeBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
            
            // 如果是当前选中的属性，高亮显示
            if (this.selectedType === type.name) {
                typeBtn.style.border = '3px solid white';
                typeBtn.style.boxShadow = `0 0 15px ${type.color}`;
                typeBtn.style.transform = 'scale(1.05)';
            }
            
            typeBtn.addEventListener('mouseenter', () => {
                typeBtn.style.transform = 'scale(1.05)';
                typeBtn.style.borderColor = 'white';
                typeBtn.style.boxShadow = `0 0 15px ${type.color}`;
            });
            
            typeBtn.addEventListener('mouseleave', () => {
                if (this.selectedType === type.name) {
                    typeBtn.style.border = '3px solid white';
                    typeBtn.style.transform = 'scale(1.05)';
                } else {
                    typeBtn.style.transform = 'scale(1)';
                    typeBtn.style.borderColor = 'rgba(255,255,255,0.3)';
                    typeBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
                }
            });
            
            typeBtn.addEventListener('click', () => {
                // 选择属性
                this.selectedType = type.name;
                this.selectedTypeColor = type.color;
                
                // 更新按钮显示
                buttonElement.textContent = `命定属性：${type.name}`;
                buttonElement.style.background = `linear-gradient(45deg, ${type.color}, ${this.lightenColor(type.color, 20)})`;
                buttonElement.style.border = '2px solid white';
                buttonElement.style.boxShadow = `0 4px 15px ${type.color}80`;
                
                // 关闭对话框
                document.body.removeChild(overlay);
                
                // 记录选择
                console.log(`[属性] 选择命定属性: ${type.name}`);
                this.logMessage('系统', `命定属性已设为【${type.name}】`);
                
                // 如果有游戏板，更新命定属性
                if (this.gameBoard) {
                    this.gameBoard.playerChosenType = type.name;
                    console.log(`[属性] 游戏板命定属性已更新: ${type.name}`);
                }
            });
            
            grid.appendChild(typeBtn);
        });
        
        // 操作按钮行
        const actionRow = document.createElement('div');
        actionRow.style.display = 'flex';
        actionRow.style.gap = '10px';
        actionRow.style.marginTop = '5px';
        dialog.appendChild(actionRow);
        
        // 取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.flex = '1';
        cancelBtn.style.padding = '12px 10px';
        cancelBtn.style.fontSize = '16px';
        cancelBtn.style.fontWeight = 'bold';
        cancelBtn.style.color = 'white';
        cancelBtn.style.background = 'linear-gradient(45deg, #666, #888)';
        cancelBtn.style.border = 'none';
        cancelBtn.style.borderRadius = '25px';
        cancelBtn.style.cursor = 'pointer';
        cancelBtn.style.transition = 'transform 0.2s';
        
        cancelBtn.addEventListener('mouseenter', () => {
            cancelBtn.style.transform = 'scale(1.02)';
        });
        
        cancelBtn.addEventListener('mouseleave', () => {
            cancelBtn.style.transform = 'scale(1)';
        });
        
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        
        actionRow.appendChild(cancelBtn);
        
        // 如果有当前选中的属性，添加重置按钮
        if (this.selectedType) {
            const resetBtn = document.createElement('button');
            resetBtn.textContent = '重置选择';
            resetBtn.style.flex = '1';
            resetBtn.style.padding = '12px 10px';
            resetBtn.style.fontSize = '16px';
            resetBtn.style.fontWeight = 'bold';
            resetBtn.style.color = 'white';
            resetBtn.style.background = 'linear-gradient(45deg, #8B4513, #A0522D)';
            resetBtn.style.border = 'none';
            resetBtn.style.borderRadius = '25px';
            resetBtn.style.cursor = 'pointer';
            resetBtn.style.transition = 'transform 0.2s';
            
            resetBtn.addEventListener('mouseenter', () => {
                resetBtn.style.transform = 'scale(1.02)';
            });
            
            resetBtn.addEventListener('mouseleave', () => {
                resetBtn.style.transform = 'scale(1)';
            });
            
            resetBtn.addEventListener('click', () => {
                // 重置属性选择
                this.selectedType = null;
                this.selectedTypeColor = null;
                
                // 更新按钮显示
                buttonElement.textContent = '点击选择属性';
                buttonElement.style.background = 'linear-gradient(45deg, #757575, #9E9E9E)';
                buttonElement.style.border = '2px solid white';
                buttonElement.style.boxShadow = '0 4px 15px rgba(0,0,0,0.3)';
                
                // 关闭对话框
                document.body.removeChild(overlay);
                
                // 记录重置
                console.log(`[属性] 重置命定属性选择`);
                this.logMessage('系统', '命定属性已重置');
            });
            
            actionRow.appendChild(resetBtn);
        }
        
        // 添加滚动条样式
        const style = document.createElement('style');
        style.textContent = `
            ::-webkit-scrollbar {
                width: 6px;
            }
            ::-webkit-scrollbar-track {
                background: rgba(255,255,255,0.1);
                border-radius: 3px;
            }
            ::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.3);
                border-radius: 3px;
            }
            ::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.5);
            }
        `;
        dialog.appendChild(style);
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    // 新增：辅助方法，提亮颜色
    lightenColor(color, percent) {
        // 简化版，实际项目中可以使用完整的颜色处理
        return color;
    }

    // 修改setGameStartState方法，更新按钮状态
    setGameStartState(started) {
        this.gameStarted = started;
        
        if (this.typeSelectBtn) {
            if (started) {
                this.typeSelectBtn.style.opacity = '0.8';
                this.typeSelectBtn.style.cursor = 'not-allowed';
                this.typeSelectBtn.style.pointerEvents = 'none';
                this.typeSelectBtn.style.filter = 'grayscale(30%)';
            } else {
                this.typeSelectBtn.style.opacity = '1';
                this.typeSelectBtn.style.cursor = 'pointer';
                this.typeSelectBtn.style.pointerEvents = 'auto';
                this.typeSelectBtn.style.filter = 'none';
                
                if (!this.selectedType) {
                    this.typeSelectBtn.textContent = '⚡ 点击选择命定属性';
                    this.typeSelectBtn.style.background = 'linear-gradient(45deg, #757575, #9E9E9E)';
                }
            }
        }
    }

    // 修改createButton方法，优化按钮样式
    createButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.padding = '12px 20px';
        button.style.fontSize = '16px';
        button.style.fontWeight = 'bold';
        button.style.color = 'white';
        button.style.border = 'none';
        button.style.borderRadius = '30px';
        button.style.cursor = 'pointer';
        button.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
        button.style.transition = 'transform 0.2s, box-shadow 0.2s';
        button.style.display = 'flex';
        button.style.alignItems = 'center';
        button.style.justifyContent = 'center';
        button.style.gap = '5px';
        
        button.addEventListener('click', onClick);
        button.addEventListener('mousedown', () => {
            button.style.transform = 'scale(0.95)';
        });
        button.addEventListener('mouseup', () => {
            button.style.transform = 'scale(1)';
        });
        button.addEventListener('mouseleave', () => {
            button.style.transform = 'scale(1)';
        });
        
        return button;
    }

    // 修改summonAllBalls方法，在第一次召唤时锁定属性
    async summonAllBalls() {
        // 检查是否选择了命定属性
        if (!this.selectedType) {
            this.logMessage('错误', '请先选择命定属性！');
            return;
        }
        
        if (this.isSummoning || this.isGameOver) return;
        if (this.gameBoard.ballsRemaining <= 0) {
            this.logMessage('错误', '没有精灵球了！');
            return;
        }
        
        // 第一次召唤时锁定属性选择
        if (!this.gameStarted) {
            this.setGameStartState(true);
            this.logMessage('系统', `游戏开始，命定属性已锁定为【${this.selectedType}】`);
        }
        
        this.isSummoning = true;
        this.logMessage('系统', '开始批量投放所有精灵球...');

        try {
            const results = await this.gameBoard.summonAllBalls();
            
            if (results && results.length > 0) {
                const ballImage = await this.imageLoader.loadBallImage();
                
                for (const result of results) {
                    const index = result.index;
                    const cell = this.gridCells[index];
                    
                    await this.imageLoader.loadPokemonImage(result.pokemon.data.id);
                    
                    // 立即设置宝可梦
                    cell.setPokemon(result.pokemon, this.imageLoader);
                    cell.updateDisplay();
                    
                    await this.delay(300);
                    
                    await this.playDirectSummonAnimation(cell, result.pokemon);
                }
                
                this.updateBallCounter();
                this.logMessage('系统', `批量投放完成，召唤了 ${results.length} 只宝可梦`);
            }
        } catch (error) {
            this.logMessage('错误', `批量召唤失败: ${error.message}`);
        }
        
        this.isSummoning = false;
    }

    // main.js - 修改gameOver方法，只显示统计
    gameOver() {
        this.isGameOver = true;
        this.logMessage('游戏结束', '精灵球已用完，游戏结束！');
        
        const stats = this.gameBoard.getGameStats();
        
        // 只显示统计摘要，不显示详细日志
        this.logMessage('统计', `=== 游戏统计 ===`);
        this.logMessage('统计', `总召唤次数: ${stats.totalSummons}`);
        this.logMessage('统计', `累计获得精灵球: ${stats.totalRewards}`);
        this.logMessage('统计', `传说宝可梦出场: ${stats.legendarySummoned}`);
        this.logMessage('统计', `幻之宝可梦出场: ${stats.mythicalSummoned}`);
        
        // 可以添加一些有趣的统计
        const shinyCount = stats.gameLog.filter(log => 
            log.message && log.message.includes('异色')
        ).length;
        
        if (shinyCount > 0) {
            this.logMessage('统计', `异色宝可梦遇见: ${shinyCount}`);
        }
        
        const evolutionCount = stats.gameLog.filter(log => 
            log.type === '进化'
        ).length;
        
        if (evolutionCount > 0) {
            this.logMessage('统计', `进化次数: ${evolutionCount}`);
        }
    }

    // main.js - 正确的restartGame方法
    restartGame() {
        console.log('重新开始游戏');
        
        this.isGameOver = false;
        this.isSummoning = false;
        this.gameStarted = false; // 重置游戏开始状态
        
        // 清空消息
        this.messageBoard.clear();
        
        // 重新初始化游戏板，保留选中的属性
        const allTypes = this.pokemonData.getAllTypes();
        const chosenType = this.selectedType || allTypes[0]; // 如果已选则使用，否则默认
        
        this.gameBoard = new GameBoard(
            this.pokemonData, 
            chosenType, 
            9,
            (type, message) => this.immediateLogMessage(type, message)
        );
        
        // 设置游戏板的命定属性
        if (this.selectedType) {
            this.gameBoard.playerChosenType = this.selectedType;
        }
        
        // 重新设置事件监听器
        this.setupEventHandlers();
        
        // 使用initializeGridCells方法（已经在loadGame中定义）
        this.initializeGridCells();
        
        // 更新UI
        this.updateBallCounter();
        
        // 启用属性选择
        this.setGameStartState(false);
        
        this.logMessage('系统', '游戏已重新开始！');
        
        if (this.selectedType) {
            this.logMessage('系统', `当前命定属性为【${this.selectedType}】`);
        } else {
            this.logMessage('系统', '请选择命定属性开始游戏');
        }
    }

    // main.js - 修复setupEventHandlers
    setupEventHandlers() {
        if (!this.gameBoard) return;
        
        console.log('[事件] 设置游戏事件处理器');
        
        // 保存原始log方法
        const originalLog = this.gameBoard.logGameEvent;
        
        // 重写log方法以实时捕获所有事件
        this.gameBoard.logGameEvent = (type, message) => {
            // 调用原始方法
            if (originalLog) {
                originalLog.call(this.gameBoard, type, message);
            }
            
            console.log(`[GameBoard->UI] ${type}: ${message}`);
            
            // 立即转发到消息板（排除某些类型的消息）
            const excludeTypes = ['进度']; // 只排除进度消息
            
            if (!excludeTypes.includes(type)) {
                // 立即显示
                this.immediateLogMessage(type, message);
            }
        };
    }

    // main.js - 修改immediateLogMessage方法，处理带触发位置的规则奖励
    immediateLogMessage(type, message, triggerIndex = null) {
        console.log(`[UI显示] ${type}: ${message}`);
        
        let displayType = type;
        let color = '#FFFFFF';
        
        switch(type) {
            case '奖励':
            case '规则奖励':
                color = '#81C784';
                displayType = '奖励';
                break;
            case '规则':
                color = '#4FC3F7';
                break;
            case '进化':
                color = '#BA68C8';
                break;
            case '召唤':
                color = '#64B5F6';
                break;
            case '变身':
                color = '#9575CD';
                break;
            case '游戏结束':
                color = '#FF5252';
                break;
            case '错误':
                color = '#F44336';
                break;
            case '系统':
                color = '#FFD700';
                break;
            case '统计':
                color = '#FFD700';
                break;
        }
        
        this.messageBoard.addMessage(displayType, message, color);
        
        // 如果是规则奖励且有触发位置，播放精灵球飞行动画
        if (type === '规则奖励' && triggerIndex !== null) {
            const triggerCell = this.gridCells[triggerIndex];
            if (triggerCell) {
                setTimeout(() => {
                    this.playBallFlyAnimation(triggerCell);
                }, 100); // 稍微延迟，让消息先显示
            }
        }
    }

    // 修改logMessage方法，也使用immediateLogMessage
    logMessage(type, message) {
        this.immediateLogMessage(type, message);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // main.js - 添加initializeGridCells方法（如果还没有）
    initializeGridCells() {
        console.log('[初始化] 初始化格子状态');
        if (this.gridCells && this.gridCells.length > 0) {
            this.gridCells.forEach(cell => {
                if (cell && typeof cell.clear === 'function') {
                    cell.clear();
                    cell.updateDisplay();
                }
            });
        }
    }

    // main.js - 修复playBallFlyAnimation，只加一次球
    async playBallFlyAnimation(startCell, rewardBalls = 1) {
        if (!startCell) {
            console.error('[动画] 无法播放精灵球飞行：起始格子为空');
            return;
        }
        
        const ballImage = await this.imageLoader.loadBallImage();
        
        const startPos = startCell.getCenterPosition();
        
        const ballCounterElement = this.ballCountSpan;
        if (!ballCounterElement) {
            console.error('[动画] 无法播放精灵球飞行：找不到计数元素');
            return;
        }
        
        const counterRect = ballCounterElement.getBoundingClientRect();
        const endPos = {
            x: counterRect.left + counterRect.width / 2,
            y: counterRect.top + counterRect.height / 2
        };
        
        console.log(`[动画] 精灵球飞行: +${rewardBalls}球, (${startPos.x}, ${startPos.y}) -> (${endPos.x}, ${endPos.y})`);
        
        return new Promise((resolve) => {
            const duration = 800;
            const startTime = performance.now();
            const ballScale = 1.2;
            
            const flyCanvas = document.createElement('canvas');
            flyCanvas.width = 50;
            flyCanvas.height = 50;
            flyCanvas.style.position = 'fixed';
            flyCanvas.style.left = '0';
            flyCanvas.style.top = '0';
            flyCanvas.style.pointerEvents = 'none';
            flyCanvas.style.zIndex = '1000';
            document.body.appendChild(flyCanvas);
            
            const flyCtx = flyCanvas.getContext('2d');
            
            // 标记是否已经加过球
            let ballAdded = false;
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                const easeProgress = 1 - Math.pow(1 - progress, 2);
                
                const controlX = (startPos.x + endPos.x) / 2;
                const controlY = Math.min(startPos.y, endPos.y) - 80;
                
                const x = Math.pow(1 - easeProgress, 2) * startPos.x +
                        2 * (1 - easeProgress) * easeProgress * controlX +
                        Math.pow(easeProgress, 2) * endPos.x;
                
                const y = Math.pow(1 - easeProgress, 2) * startPos.y +
                        2 * (1 - easeProgress) * easeProgress * controlY +
                        Math.pow(easeProgress, 2) * endPos.y;
                
                const rotation = progress * 1080;
                const scale = ballScale * (1 - progress * 0.5);
                const alpha = progress > 0.8 ? 1 - (progress - 0.8) * 5 : 1;
                
                flyCtx.clearRect(0, 0, 50, 50);
                
                flyCtx.save();
                flyCtx.translate(25, 25);
                flyCtx.rotate(rotation * Math.PI / 180);
                flyCtx.globalAlpha = alpha;
                flyCtx.drawImage(
                    ballImage,
                    -ballImage.width * scale / 2,
                    -ballImage.height * scale / 2,
                    ballImage.width * scale,
                    ballImage.height * scale
                );
                
                if (rewardBalls > 1) {
                    flyCtx.font = 'bold 16px Arial';
                    flyCtx.fillStyle = 'white';
                    flyCtx.strokeStyle = 'black';
                    flyCtx.lineWidth = 3;
                    flyCtx.textAlign = 'center';
                    flyCtx.textBaseline = 'middle';
                    flyCtx.strokeText(`+${rewardBalls}`, 25, -20);
                    flyCtx.fillText(`+${rewardBalls}`, 25, -20);
                }
                
                flyCtx.restore();
                
                flyCanvas.style.left = `${x - 25}px`;
                flyCanvas.style.top = `${y - 25}px`;
                
                // 在精灵球接近终点时加球
                if (!ballAdded && progress > 0.9) {
                    ballAdded = true;
                    if (this.gameBoard) {
                        // 只在这里加球！
                        this.gameBoard.ballsRemaining += rewardBalls;
                        this.gameBoard.totalBallsAdded += rewardBalls;
                        this.updateBallCounter();
                        
                        this.ballCountSpan.style.transform = 'scale(1.5)';
                        this.ballCountSpan.style.transition = 'transform 0.2s';
                        setTimeout(() => {
                            this.ballCountSpan.style.transform = 'scale(1)';
                        }, 200);
                        
                        console.log(`[计数] 精灵球+${rewardBalls}，当前剩余: ${this.gameBoard.ballsRemaining}`);
                    }
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    document.body.removeChild(flyCanvas);
                    resolve();
                }
            };
            
            animate();
        });
    }

    // main.js - 修改processPendingRewards，按顺序处理所有奖励
    async processPendingRewards() {
        if (!this.gameBoard || !this.gameBoard.pendingRewards) return;
        
        // 按时间戳排序，确保顺序
        const rewards = [...this.gameBoard.pendingRewards].sort((a, b) => a.order - b.order);
        this.gameBoard.pendingRewards = [];
        
        console.log(`[奖励] 开始顺序处理 ${rewards.length} 个奖励`);
        
        for (let i = 0; i < rewards.length; i++) {
            const reward = rewards[i];
            const ballCount = parseInt(reward.balls) || 1;
            
            // 所有奖励都飞球
            if (reward.triggerIndex !== null && reward.triggerIndex !== undefined) {
                const triggerCell = this.gridCells[reward.triggerIndex];
                if (triggerCell && triggerCell.isActive) {
                    console.log(`[奖励] [${i+1}/${rewards.length}] 从格子 ${reward.triggerIndex} 飞出 ${ballCount} 个精灵球 (${reward.type})`);
                    await this.playBallFlyAnimation(triggerCell, ballCount);
                    await this.delay(200); // 增加延迟，让动画更清晰
                } else {
                    // 如果触发格子已消除，找其他格子
                    console.warn(`[奖励] 触发格子 ${reward.triggerIndex} 已消除，寻找替代格子`);
                    for (let j = 0; j < this.gridCells.length; j++) {
                        if (this.gridCells[j].pokemon) {
                            await this.playBallFlyAnimation(this.gridCells[j], ballCount);
                            await this.delay(200);
                            break;
                        }
                    }
                }
            } else {
                // 没有触发位置，找第一个有宝可梦的格子
                console.warn(`[奖励] 奖励没有触发位置: ${reward.message}`);
                for (let j = 0; j < this.gridCells.length; j++) {
                    if (this.gridCells[j].pokemon) {
                        await this.playBallFlyAnimation(this.gridCells[j], ballCount);
                        await this.delay(200);
                        break;
                    }
                }
            }
        }
        
        console.log(`[奖励] 所有奖励处理完成`);
    }
}

// 启动游戏
const game = new VisualGame();

window.addEventListener('resize', () => {
    console.log('窗口大小变化，需要重新布局');
});