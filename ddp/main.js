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

    async loadGame() {
        this.logMessage('系统', '正在加载宝可梦数据...');
        
        try {
            const loaded = await this.pokemonData.loadData('./data/pokemon_config.json');
            if (!loaded) {
                this.logMessage('错误', '无法加载宝可梦数据');
                return;
            }
            
            const ballImage = await this.imageLoader.loadBallImage();
            this.ballCounter.setBallImage(ballImage);
            
            const allTypes = this.pokemonData.getAllTypes();
            const chosenType = allTypes[0];
            this.gameBoard = new GameBoard(this.pokemonData, chosenType, 9);
            
            this.gridCells.forEach(cell => {
                cell.typeColors = this.pokemonData.typeColors;
            });
            
            // 初始化格子
            this.gridCells.forEach(cell => {
                cell.clear();
                cell.updateDisplay();
            });
            
            this.logMessage('系统', '游戏准备就绪！点击"扔球"开始游戏');
            
        } catch (error) {
            this.logMessage('错误', `加载失败: ${error.message}`);
            console.error(error);
        }
    }

    // main.js - 修改summonPokemon方法，恢复召唤消息
    async summonPokemon() {
        if (this.isSummoning || this.isGameOver) return;
        if (this.gameBoard.ballsRemaining <= 0) {
            this.logMessage('错误', '没有精灵球了！');
            return;
        }
        
        this.isSummoning = true;
        console.log('=== 开始召唤 ===');
        
        try {
            // 执行召唤逻辑
            const result = this.gameBoard.summonPokemon();
            
            if (result) {
                const index = result.gridIndex;
                const cell = this.gridCells[index];
                
                console.log(`召唤宝可梦: ${result.data.name}, 格子 ${index}`);
                
                // 预加载当前宝可梦图片
                console.log(`预加载宝可梦图片: ${result.data.id}`);
                await this.imageLoader.loadPokemonImage(result.data.id);
                
                // 设置宝可梦到格子
                cell.setPokemon(result, this.imageLoader);
                
                // 播放动画
                await this.playDirectSummonAnimation(cell, result);
                
                // 预加载所有场上宝可梦的图片
                await this.preloadAllPokemonImages();
                
                // 使用完整的同步方法
                setTimeout(async () => {
                    await this.syncGridWithGameBoard();
                }, 100);
                
                // 更新计数器
                this.updateBallCounter();
                
                // 检查游戏结束
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

    async syncGridWithGameBoard() {
        console.log('[同步] ========== 开始同步 ==========');
        
        if (!this.gameBoard) return;
        
        // 首先检查是否有进化事件需要处理
        const hasEvolution = await this.checkAndProcessEvolutions();
        
        if (hasEvolution) {
            console.log('[同步] 已处理进化事件，重新同步');
            // 如果处理了进化，需要重新检查整个状态
            await this.delay(200); // 给进化动画一点时间
        }
        
        // 同步所有格子状态
        const cellsToClear = [];
        const cellsToAdd = [];
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (!gamePokemon && cellPokemon) {
                cellsToClear.push({ index: i, cell, pokemon: cellPokemon });
            } else if (gamePokemon && !cellPokemon) {
                cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
            } else if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                // 宝可梦变化（不是进化，因为进化已经在前面处理了）
                cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
            }
        }
        
        // 处理消除
        if (cellsToClear.length > 0) {
            console.log(`[同步] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            if (cellsToClear.length === 2) {
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell
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
                // 确保图片已加载
                try {
                    await this.imageLoader.loadPokemonImage(pokemon.data.id);
                } catch (error) {
                    console.warn(`[同步] 加载图片 ${pokemon.data.id} 失败，使用占位符`);
                }
                cell.setPokemon(pokemon, this.imageLoader);
                cell.updateDisplay();
            }
        }
        
        // 更新球计数器
        this.updateBallCounter();
        
        console.log('[同步] 同步完成');
    }

    // 新增：专门检查和处理进化
    async checkAndProcessEvolutions() {
        let hasEvolution = false;
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                if (this.isEvolution(cellPokemon, gamePokemon)) {
                    console.log(`[进化检测] 发现进化: 格子 ${i}, ${cellPokemon.data.name} -> ${gamePokemon.data.name}`);
                    
                    // 预加载新宝可梦图片
                    await this.imageLoader.loadPokemonImage(gamePokemon.data.id);
                    
                    // 播放进化动画
                    await this.playEvolutionAnimation(cell, gamePokemon);
                    
                    hasEvolution = true;
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

    // 新增方法：播放消失动画
    async playDisappearAnimation(cell) {
        console.log(`[动画] 播放消失动画，格子 ${cell.index}`);
        
        return new Promise((resolve) => {
            const duration = 400;
            const startTime = performance.now();
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // 清空画布
                cell.ctx.clearRect(0, 0, cell.size, cell.size);
                
                // 淡出效果
                if (progress < 0.8) {
                    // 在消失过程中绘制宝可梦
                    cell.ctx.globalAlpha = 1 - (progress / 0.8);
                    
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
                    
                    // 绘制宝可梦（缩小）
                    if (cell.sprite) {
                        const scale = 1 - (progress / 0.8) * 0.5; // 缩小50%
                        
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
                    
                    cell.ctx.globalAlpha = 1.0;
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    // 动画完成，清除格子
                    cell.clear();
                    resolve();
                }
            };
            
            animate();
        });
    }

    // 新增方法：播放对对碰消除动画
    async playPairEliminationAnimation(cell1, cell2) {
        console.log(`[动画] 播放对对碰消除动画，格子 ${cell1.index} 和 ${cell2.index}`);
        
        return new Promise((resolve) => {
            const duration = 600;
            const startTime = performance.now();
            
            // 记录原始位置
            const originalPos1 = { x: cell1.x + cell1.size / 2, y: cell1.y + cell1.size / 2 };
            const originalPos2 = { x: cell2.x + cell2.size / 2, y: cell2.y + cell2.size / 2 };
            
            // 计算飞向的目标位置（屏幕上方）
            const targetX = window.innerWidth / 2;
            const targetY = 50;
            
            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // 清空两个格子
                cell1.ctx.clearRect(0, 0, cell1.size, cell1.size);
                cell2.ctx.clearRect(0, 0, cell2.size, cell2.size);
                
                if (progress < 0.7) {
                    // 第一阶段：缩小并飞向目标
                    const scale = 1 - progress * 0.7;
                    const pos1 = {
                        x: originalPos1.x + (targetX - originalPos1.x) * progress,
                        y: originalPos1.y + (targetY - originalPos1.y) * progress
                    };
                    const pos2 = {
                        x: originalPos2.x + (targetX - originalPos2.x) * progress,
                        y: originalPos2.y + (targetY - originalPos2.y) * progress
                    };
                    
                    // 绘制第一个宝可梦
                    cell1.ctx.save();
                    cell1.ctx.translate(pos1.x - cell1.x, pos1.y - cell1.y);
                    cell1.ctx.scale(scale, scale);
                    
                    if (cell1.pokemon && cell1.pokemon.currentTypes && cell1.pokemon.currentTypes[0]) {
                        const typeColor = cell1.typeColors[cell1.pokemon.currentTypes[0]] || '#A8A878';
                        cell1.ctx.fillStyle = typeColor;
                        cell1.ctx.fillRect(-20, -20, 40, 40);
                    }
                    
                    if (cell1.sprite) {
                        cell1.ctx.drawImage(
                            cell1.sprite,
                            -cell1.sprite.width / 2,
                            -cell1.sprite.height / 2
                        );
                    }
                    cell1.ctx.restore();
                    
                    // 绘制第二个宝可梦
                    cell2.ctx.save();
                    cell2.ctx.translate(pos2.x - cell2.x, pos2.y - cell2.y);
                    cell2.ctx.scale(scale, scale);
                    
                    if (cell2.pokemon && cell2.pokemon.currentTypes && cell2.pokemon.currentTypes[0]) {
                        const typeColor = cell2.typeColors[cell2.pokemon.currentTypes[0]] || '#A8A878';
                        cell2.ctx.fillStyle = typeColor;
                        cell2.ctx.fillRect(-20, -20, 40, 40);
                    }
                    
                    if (cell2.sprite) {
                        cell2.ctx.drawImage(
                            cell2.sprite,
                            -cell2.sprite.width / 2,
                            -cell2.sprite.height / 2
                        );
                    }
                    cell2.ctx.restore();
                }
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    // 动画完成，清除格子
                    cell1.clear();
                    cell2.clear();
                    resolve();
                }
            };
            
            animate();
        });
    }

    // main.js - 完整的syncGridWithGameBoard方法
    async syncGridWithGameBoard() {
        console.log('[同步] ========== 开始同步 ==========');
        console.log('[同步] 当前游戏板状态:');
        
        // 打印游戏板状态
        const gridState = this.gameBoard.grid.map((p, i) => 
            `${i}:${p?.data?.name || '空'}`
        ).join(' ');
        console.log(`[同步] ${gridState}`);
        
        if (!this.gameBoard) return;
        
        // 首先找出所有需要处理的格子
        const cellsToClear = [];
        const cellsToEvolve = [];
        const cellsToAdd = [];
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            console.log(`[同步] 格子 ${i}: 游戏板=${gamePokemon?.data?.name || '空'}, UI=${cellPokemon?.data?.name || '空'}`);
            
            if (!gamePokemon && cellPokemon) {
                // 需要消除的格子
                cellsToClear.push({ index: i, cell, pokemon: cellPokemon });
            } else if (gamePokemon && !cellPokemon) {
                // 需要添加的格子（不应该发生）
                cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
            } else if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                // 宝可梦变化 - 检查是否是进化
                if (this.isEvolution(cellPokemon, gamePokemon)) {
                    // 确保新宝可梦图片已加载
                    console.log(`[同步] 预加载进化宝可梦图片: ${gamePokemon.data.id}`);
                    await this.imageLoader.loadPokemonImage(gamePokemon.data.id);
                    
                    cellsToEvolve.push({ 
                        index: i, 
                        cell, 
                        oldPokemon: cellPokemon, 
                        newPokemon: gamePokemon 
                    });
                } else {
                    // 其他变化（如变身）
                    cellsToAdd.push({ index: i, cell, pokemon: gamePokemon });
                }
            }
        }
        
        // 处理进化（优先处理）
        if (cellsToEvolve.length > 0) {
            console.log(`[同步] 发现 ${cellsToEvolve.length} 个格子需要进化`);
            
            for (const { index, cell, oldPokemon, newPokemon } of cellsToEvolve) {
                console.log(`[同步] 格子 ${index} 进化: ${oldPokemon.data.name} -> ${newPokemon.data.name}`);
                await this.playEvolutionAnimation(cell, newPokemon);
            }
        }
        
        // 处理消除
        if (cellsToClear.length > 0) {
            console.log(`[同步] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            // 如果是成对消除（对对碰）
            if (cellsToClear.length === 2) {
                // 播放对对碰消除动画
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell
                );
            } else {
                // 其他情况（三连、单个等）
                for (const { cell } of cellsToClear) {
                    await this.playDisappearAnimation(cell);
                }
            }
        }
        
        // 处理添加（其他变化）
        if (cellsToAdd.length > 0) {
            console.log(`[同步] 发现 ${cellsToAdd.length} 个格子需要更新`);
            for (const { cell, pokemon } of cellsToAdd) {
                // 确保图片已加载
                await this.imageLoader.loadPokemonImage(pokemon.data.id);
                cell.setPokemon(pokemon, this.imageLoader);
                cell.updateDisplay();
            }
        }
        
        // 最后更新球计数器
        this.updateBallCounter();
        
        console.log('[同步] 同步完成');
    }

    // 直接播放动画，不使用动画管理器
    async playDirectSummonAnimation(cell, pokemonInstance) {
        const ballImage = await this.imageLoader.loadBallImage();
        
        console.log(`播放召唤动画，格子 ${cell.index}`);
        
        return new Promise((resolve) => {
            // 步骤1: 抛物线动画
            this.playParabolaAnimation(cell, ballImage, () => {
                console.log(`精灵球动画完成，格子 ${cell.index}`);
                
                // 步骤2: 宝可梦出现动画
                this.playPokemonAppearAnimation(cell, () => {
                    console.log(`宝可梦出现动画完成，格子 ${cell.index}`);
                    
                    // 测试：立即显示一条召唤完成消息
                    this.logMessage('召唤', `${pokemonInstance.data.name}登场完成！`);
                    
                    // 步骤3: 如果是异色，播放特效
                    if (pokemonInstance.isShiny) {
                        this.playShinyEffect(cell, resolve);
                    } else {
                        resolve();
                    }
                });
            });
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

    // 宝可梦出现动画
    playPokemonAppearAnimation(cell, onComplete) {
        const duration = 500;
        const startTime = performance.now();
        
        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 从小放大
            const scale = 0.1 + (0.9 * progress);
            
            // 清空并重新绘制
            cell.ctx.clearRect(0, 0, cell.size, cell.size);
            
            // 绘制背景（根据宝可梦属性）
            if (cell.pokemon && cell.pokemon.currentTypes && cell.pokemon.currentTypes[0]) {
                const mainType = cell.pokemon.currentTypes[0];
                const typeColor = cell.typeColors[mainType] || '#A8A878';
                
                cell.ctx.fillStyle = `${typeColor}66`;
                cell.ctx.fillRect(0, 0, cell.size, cell.size);
                
                cell.ctx.strokeStyle = typeColor;
                cell.ctx.lineWidth = 3;
                cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
            }
            
            // 绘制宝可梦（缩放）
            if (cell.sprite) {
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
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // 动画完成，最终更新显示
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

    updateBallCounter() {
        if (!this.gameBoard) return;
        this.ballCounter.setCount(this.gameBoard.ballsRemaining);
        this.ballCounter.setTotalAdded(this.gameBoard.totalBallsAdded);
    }

    // ... 其他UI方法保持不变（initUI, createGameGrid, createControls等）
    // 这些方法与你之前提供的版本相同

    initUI() {
        document.body.style.margin = '0';
        document.body.style.overflow = 'hidden';
        document.body.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        
        const container = document.createElement('div');
        container.id = 'game-container';
        container.style.width = '100vw';
        container.style.height = '100vh';
        container.style.position = 'relative';
        container.style.maxWidth = '500px';
        container.style.margin = '0 auto';
        container.style.background = 'rgba(0, 0, 0, 0.3)';
        document.body.appendChild(container);
        
        this.container = container;
        
        const title = document.createElement('div');
        title.textContent = '宝可梦对对碰';
        title.style.textAlign = 'center';
        title.style.color = '#FFD700';
        title.style.fontSize = '24px';
        title.style.fontWeight = 'bold';
        title.style.padding = '20px 0';
        title.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
        container.appendChild(title);
        
        this.ballCounter = new BallCounter(10, 70);
        container.appendChild(this.ballCounter.getElement());
        
        this.createGameGrid();
        
        const messageBoardHeight = 150;
        const messageBoardY = window.innerHeight - messageBoardHeight - 80;
        this.messageBoard = new MessageBoard(10, messageBoardY, 380, messageBoardHeight);
        container.appendChild(this.messageBoard.getElement());
        
        this.createControls();
    }

    createGameGrid() {
        const container = this.container;
        const gridSize = Math.min(window.innerWidth - 40, 400);
        const cellSize = gridSize / 3;
        const gridX = (container.clientWidth - gridSize) / 2;
        const gridY = 150;
        
        const gridBg = document.createElement('div');
        gridBg.style.position = 'absolute';
        gridBg.style.left = `${gridX}px`;
        gridBg.style.top = `${gridY}px`;
        gridBg.style.width = `${gridSize}px`;
        gridBg.style.height = `${gridSize}px`;
        gridBg.style.background = 'rgba(255, 255, 255, 0.1)';
        gridBg.style.borderRadius = '10px';
        gridBg.style.display = 'grid';
        gridBg.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridBg.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridBg.style.gap = '5px';
        gridBg.style.padding = '5px';
        container.appendChild(gridBg);
        
        this.gridCells = [];
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                const index = row * 3 + col;
                const x = gridX + col * cellSize + 5;
                const y = gridY + row * cellSize + 5;
                
                const cell = new PokemonCell(index, x, y, cellSize - 10);
                this.gridCells.push(cell);
                container.appendChild(cell.getElement());
                
                const placeholder = document.createElement('div');
                placeholder.style.background = 'rgba(255, 255, 255, 0.05)';
                placeholder.style.borderRadius = '5px';
                gridBg.appendChild(placeholder);
            }
        }
    }

    createControls() {
        const container = this.container;
        const controls = document.createElement('div');
        controls.style.position = 'absolute';
        controls.style.bottom = '20px';
        controls.style.left = '0';
        controls.style.right = '0';
        controls.style.display = 'flex';
        controls.style.justifyContent = 'center';
        controls.style.gap = '20px';
        controls.style.padding = '0 20px';
        container.appendChild(controls);
        
        const throwBtn = this.createButton('扔球', () => this.summonPokemon());
        controls.appendChild(throwBtn);
        
        const throwAllBtn = this.createButton('扔所有球', () => this.summonAllBalls());
        controls.appendChild(throwAllBtn);
        
        const restartBtn = this.createButton('重新开始', () => this.restartGame());
        controls.appendChild(restartBtn);
    }

    createButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.padding = '15px 30px';
        button.style.fontSize = '16px';
        button.style.fontWeight = 'bold';
        button.style.color = 'white';
        button.style.background = 'linear-gradient(45deg, #2196F3, #21CBF3)';
        button.style.border = 'none';
        button.style.borderRadius = '25px';
        button.style.cursor = 'pointer';
        button.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
        button.style.transition = 'transform 0.2s';
        
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

    async summonAllBalls() {
        if (this.isSummoning || this.isGameOver) return;
        if (this.gameBoard.ballsRemaining <= 0) {
            this.logMessage('错误', '没有精灵球了！');
            return;
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

    restartGame() {
        console.log('重新开始游戏');
        
        this.isGameOver = false;
        this.isSummoning = false;
        
        this.messageBoard.clear();
        
        const allTypes = this.pokemonData.getAllTypes();
        const chosenType = allTypes[0];
        this.gameBoard = new GameBoard(this.pokemonData, chosenType, 9);
        
        this.gridCells.forEach(cell => {
            cell.clear();
            cell.updateDisplay();
        });
        
        this.updateBallCounter();
        
        this.logMessage('系统', '游戏已重新开始！');
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

    // main.js - 修复immediateLogMessage方法
    immediateLogMessage(type, message) {
        console.log(`[UI显示] ${type}: ${message}`);
        
        // 设置不同类型的显示样式
        let displayType = type;
        let color = '#FFFFFF';
        
        switch(type) {
            case '奖励':
                color = '#81C784'; // 绿色
                break;
            case '规则':
                color = '#4FC3F7'; // 蓝色
                break;
            case '进化':
                color = '#BA68C8'; // 紫色
                break;
            case '召唤':
                color = '#64B5F6'; // 浅蓝色
                displayType = '召唤'; // 确保类型正确
                break;
            case '变身':
                color = '#9575CD'; // 紫色
                break;
            case '游戏结束':
                color = '#FF5252'; // 红色
                break;
            case '错误':
                color = '#F44336'; // 红色
                break;
            case '统计':
                color = '#FFD700'; // 金色
                break;
            case '行动':
                color = '#A0A0A0'; // 灰色
                break;
        }
        
        // 立即添加到消息板
        try {
            this.messageBoard.addMessage(displayType, message, color);
        } catch (error) {
            console.error('添加消息到消息板失败:', error);
        }
    }

    // 修改logMessage方法，也使用immediateLogMessage
    logMessage(type, message) {
        this.immediateLogMessage(type, message);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 启动游戏
const game = new VisualGame();

window.addEventListener('resize', () => {
    console.log('窗口大小变化，需要重新布局');
});