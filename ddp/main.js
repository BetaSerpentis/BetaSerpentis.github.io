// main.js - 修复版本（含性能优化）
// IMPORTANT: iOS Safari 要求 import 必须在文件最顶部
import PokemonData from './core/PokemonData.js';
import GameBoard from './core/GameBoard.js';
import ImageLoader from './utils/ImageLoader.js';
import PokemonCell from './ui/PokemonCell.js';
import MessageBoard from './ui/MessageBoard.js';
import AudioManager from './utils/AudioManager.js';

// 生产环境检测：非 localhost 时禁用详细日志
const __DEV__ = (() => {
    try {
        const h = location.hostname;
        if (new URLSearchParams(location.search).get('debug') === '1') return true;
        return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.');
    } catch (e) { return false; }
})();

if (!__DEV__) {
    console.log = function() {};
    console.warn = function() {};
}

// 模块级错误可视化
window.addEventListener('error', function(e) {
    var c = document.getElementById('game-container');
    if (c) {
        c.innerHTML = '<div style="color:red;background:rgba(0,0,0,0.9);padding:20px;margin:40px;border-radius:12px;font-size:14px;line-height:1.6;word-break:break-all;">'
            + '<h2 style="color:#FF5252">⚠️ JS Error</h2>'
            + '<p><b>File:</b> ' + (e.filename || 'unknown').replace(/.*\//, '') + '</p>'
            + '<p><b>Line:</b> ' + (e.lineno || '?') + ':' + (e.colno || '?') + '</p>'
            + '<p><b>Message:</b> ' + (e.message || String(e.error)) + '</p>'
            + '</div>';
    }
});

class VisualGame {
    // main.js - 修改构造函数
    constructor() {
        this.pokemonData = new PokemonData();
        this.gameBoard = null;
        this.imageLoader = new ImageLoader();
        this.audioManager = new AudioManager(); // 添加音效管理器

        this.gridCells = [];
        this.ballCounter = null;
        this.messageBoard = null;

        this.isSummoning = false;
        this.isGameOver = false;
        this.isInitialized = false;

        this.eventLog = [];

        // 先创建UI
        this.initUI();

        // 再加载游戏数据
        this.loadGame();

        // 新增：动画队列系统
        this.animationQueue = [];
        this.isAnimating = false;
        this.pendingRewards = []; // 待处理的奖励
        // 新增：实时奖励队列（用于立即触发的奖励）
        this.immediateRewards = [];
        this.bgmStarted = false;
        this.bgmEnabled = true;

        // 性能优化：动画追踪 — 所有 rAF ID 注册在此，restartGame 时统一取消
        this._activeAnimations = new Set();
        // 性能优化：飞球 Canvas 复用池，避免每次创建新 Canvas 产生 GPU 纹理泄漏
        this._flyCanvas = null;
        this._flyCtx = null;
    }

    // ===== 性能优化：动画生命周期管理 =====

    /** 注册一个 rAF ID，使其可被统一取消 */
    _trackRaf(rafId) {
        this._activeAnimations.add(rafId);
        return rafId;
    }

    /** 移除已完成的 rAF ID */
    _untrackRaf(rafId) {
        this._activeAnimations.delete(rafId);
    }

    /** 取消所有正在运行的动画（restartGame 时调用） */
    _cancelAllAnimations() {
        for (const rafId of this._activeAnimations) {
            cancelAnimationFrame(rafId);
        }
        this._activeAnimations.clear();
        // 清理可能遗留的飞球 Canvas
        this._releaseFlyCanvas();
    }

    /** 获取复用的飞球 Canvas（延迟挂载到 DOM） */
    _getFlyCanvas() {
        if (!this._flyCanvas) {
            this._flyCanvas = document.createElement('canvas');
            this._flyCanvas.width = 50;
            this._flyCanvas.height = 50;
            this._flyCanvas.style.position = 'fixed';
            this._flyCanvas.style.left = '0';
            this._flyCanvas.style.top = '0';
            this._flyCanvas.style.pointerEvents = 'none';
            this._flyCanvas.style.zIndex = '1000';
            this._flyCtx = this._flyCanvas.getContext('2d');
        }
        if (!this._flyCanvas.parentNode) {
            document.body.appendChild(this._flyCanvas);
        }
        return { canvas: this._flyCanvas, ctx: this._flyCtx };
    }

    /** 从 DOM 移除飞球 Canvas（但保留引用供复用） */
    _releaseFlyCanvas() {
        if (this._flyCanvas && this._flyCanvas.parentNode) {
            document.body.removeChild(this._flyCanvas);
        }
    }

    // main.js - 修复triggerImmediateReward方法
    async triggerImmediateReward(cell, balls) {
        if (!cell) {
            console.error('[实时奖励] 格子不存在');
            return;
        }
        
        console.log(`[实时奖励] 立即从格子 ${cell.index} 飞出 ${balls} 个精灵球`);
        
        // 确保balls是数字
        const ballCount = parseInt(balls) || 1;
        
        // 直接播放飞球动画，不经过队列
        await this.playBallFlyAnimation(cell, ballCount);
    }

    // 修改：添加到动画队列
    queueAnimation(type, data, callback) {
        this.animationQueue.push({
            type,
            data,
            callback,
            timestamp: Date.now()
        });
        this.processAnimationQueue();
    }
    
    // main.js - 修改processAnimationQueue中的进化处理
    async processAnimationQueue() {
        if (this.isAnimating || this.animationQueue.length === 0) return;
        
        this.isAnimating = true;
        
        while (this.animationQueue.length > 0) {
            const animation = this.animationQueue.shift();
            console.log(`[动画队列] 开始: ${animation.type}`);
            
            switch(animation.type) {
                case 'evolution':
                    await this.playEvolutionAnimation(animation.data.cell, animation.data.newPokemon);
                    // 进化动画完成后，立即处理进化奖励
                    if (animation.data.rewardBalls) {
                        console.log(`[进化奖励] 从格子 ${animation.data.cell.index} 飞出 ${animation.data.rewardBalls} 个精灵球`);
                        await this.triggerImmediateReward(animation.data.cell, animation.data.rewardBalls);
                    }
                    break;
                case 'transform':
                    await this.playTransformAnimation(animation.data.cell, animation.data.transformInfo);
                    break;
                case 'disappear':
                    await this.playDisappearAnimation(animation.data.cell);
                    break;
                case 'pairElimination':
                    await this.playPairEliminationAnimation(
                        animation.data.cell1, 
                        animation.data.cell2,
                        animation.data.triggerCell
                    );
                    break;
                case 'tripleElimination':
                    await this.playTripleEliminationAnimation(
                        animation.data.cell1, 
                        animation.data.cell2, 
                        animation.data.cell3,
                        animation.data.triggerCell
                    );
                    break;
            }
            
            if (animation.callback) {
                animation.callback();
            }
            
            // 添加短暂延迟，让动画之间有间隔
            await this.delay(100);
        }
        
        this.isAnimating = false;
    }

    // main.js - 在loadGame方法中添加BGM播放
    async loadGame() {
        console.log('[系统] 开始加载游戏...');
        
        try {
            const loaded = await this.pokemonData.loadData('./data/pokemon_config.json');
            if (!loaded) {
                console.error('无法加载宝可梦数据');
                alert('无法加载宝可梦数据，请刷新页面重试');
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
            
            // 初始化游戏板
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
            
            // 设置格子颜色
            this.gridCells.forEach(cell => {
                cell.typeColors = this.pokemonData.typeColors;
            });
            
            // 初始化格子
            this.initializeGridCells();
            
            // 游戏未开始状态
            this.gameStarted = false;
            this.setGameStartState(false);
            
            // 数据加载完成后显示消息
            console.log('[系统] 游戏准备就绪！请选择命定属性开始游戏');
            
            if (this.messageBoard) {
                this.logMessage('系统', '游戏准备就绪！请选择命定属性开始游戏');
            }
            
            // 预加载BGM但不播放（等待用户交互）
            // 注意：浏览器需要用户交互才能播放音频
            this.setupBGMAutoPlay();
            
        } catch (error) {
            console.error('加载失败:', error);
            alert('游戏加载失败，请刷新页面重试');
        }
    }

    // 新增：设置BGM自动播放（需要用户交互）
    setupBGMAutoPlay() {
        // 性能修复：先移除可能残留的旧监听器，防止 restart 累积
        if (this._bgmStartHandler) {
            this.throwBtn.removeEventListener('click', this._bgmStartHandler);
            this.typeSelectBtn.removeEventListener('click', this._bgmStartHandler);
        }

        // 创建新 handler 并保存引用
        this._bgmStartHandler = () => {
            if (!this.bgmStarted) {
                this.audioManager.fadeInBGM(2000, 0.5);
                this.bgmStarted = true;
                console.log('[BGM] 游戏开始，播放背景音乐');

                // 移除自身
                this.throwBtn.removeEventListener('click', this._bgmStartHandler);
                this.typeSelectBtn.removeEventListener('click', this._bgmStartHandler);
                this._bgmStartHandler = null;
            }
        };

        // 监听扔球按钮和属性选择按钮
        this.throwBtn.addEventListener('click', this._bgmStartHandler);
        this.typeSelectBtn.addEventListener('click', this._bgmStartHandler);

        // 标记BGM是否已启动
        this.bgmStarted = false;
    }

    // main.js - 修改summonPokemon方法
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
                
                // 记录最后一次召唤的格子
                this.lastSummonedIndex = index;
                
                console.log(`召唤宝可梦: ${result.data.name}, 格子 ${index}`);
                
                // 预加载图片但不显示
                await this.imageLoader.loadPokemonImage(result.data.id);
                
                // 播放召唤动画（此时宝可梦还不显示）
                await this.playDirectSummonAnimation(cell, result);
                
                // 动画完成后才设置宝可梦到格子
                cell.setPokemon(result, this.imageLoader);
                cell.updateDisplay();
                
                // 召唤动画完成后，立即处理召唤奖励（命定属性、异色、传说、幻之等）
                if (this.gameBoard.pendingRewards && this.gameBoard.pendingRewards.length > 0) {
                    console.log(`[奖励] 发现 ${this.gameBoard.pendingRewards.length} 个待处理奖励`);
                    
                    // 先处理召唤相关的奖励（命定属性、特殊奖励）
                    const summonRewards = this.gameBoard.pendingRewards.filter(r => 
                        r.triggerIndex === index && (r.type === 'chosen' || r.type === 'special')
                    );
                    
                    for (const reward of summonRewards) {
                        console.log(`[召唤奖励] 从格子 ${index} 飞出 ${reward.balls} 个精灵球`);
                        await this.triggerImmediateReward(cell, reward.balls);
                    }
                    
                    // 从pendingRewards中移除已处理的奖励
                    this.gameBoard.pendingRewards = this.gameBoard.pendingRewards.filter(r => 
                        !(r.triggerIndex === index && (r.type === 'chosen' || r.type === 'special'))
                    );
                }
                
                // 检查是否为变身者
                if (result.data.isTransformer && result.transformInfo) {
                    console.log(`[变身流程] 开始变身动画`);
                    
                    // 变身动画加入队列
                    this.queueAnimation('transform', {
                        cell: cell,
                        transformInfo: result.transformInfo
                    });
                    
                    // 等待变身动画完成
                    await this.delay(1000);
                    
                    const transformedPokemon = this.gameBoard.executeTransform(result.transformInfo);
                    
                    if (transformedPokemon) {
                        await this.imageLoader.loadPokemonImage(transformedPokemon.data.id);
                        cell.setPokemon(transformedPokemon, this.imageLoader);
                        cell.updateDisplay();
                    }
                }
                
                // 预加载所有场上宝可梦的图片
                await this.preloadAllPokemonImages();
                
                // 同步处理（进化、消除）- 这里会处理游戏结束检查
                await this.syncGridWithGameBoard();
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

    // 修改playTripleEliminationAnimation
    async playTripleEliminationAnimation(cell1, cell2, cell3, triggerCell = null) {
        console.log(`[动画] 播放三连消除动画，格子 ${cell1.index}, ${cell2.index}, ${cell3.index}`);

        await Promise.all([
            this.playDisappearAnimation(cell1),
            this.playDisappearAnimation(cell2),
            this.playDisappearAnimation(cell3)
        ]);

        // 消除奖励：精灵球 +5
        const sourceCell = triggerCell || cell1;
        console.log(`[三连奖励] 从格子 ${sourceCell.index} 飞出精灵球`);
        await this.triggerImmediateReward(sourceCell, 5);

        // 捕获计数：3 只宝可梦被消除，累积获得 +3
        if (this.gameBoard) {
            this.gameBoard.totalBallsAdded += 3;
            this.updateBallCounter();
        }
    }

    // 修改单个消除
    async playSingleEliminationAnimation(cell) {
        await this.playDisappearAnimation(cell);
        // 单个消除通常没有奖励，或者根据规则可能有
        await this.playBallFlyAnimation(cell, 1);
    }

    // 修改playTransformAnimation，添加summon音效 + rAF 追踪 + 移除 blur 滤镜
    async playTransformAnimation(cell, transformInfo) {
        const { transformer, targetPokemon } = transformInfo;

        console.log(`[动画] 播放变身动画，格子 ${cell.index}: ${transformer.data.name} -> ${targetPokemon.data.name}`);

        await this.imageLoader.loadPokemonImage(targetPokemon.data.id);

        return new Promise((resolve) => {
            const duration = 1000;
            const startTime = performance.now();
            let rafId;

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
                    // 性能优化：用 globalAlpha 淡出代替 ctx.filter = 'blur()'
                    cell.ctx.save();
                    const blurAlpha = 1 - ((progress - 0.3) / 0.2) * 0.5;
                    if (cell.sprite) {
                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(cell.sprite.width, cell.sprite.height);
                        cell.ctx.globalAlpha = blurAlpha;
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale * (1 + (progress - 0.3) * 0.1), scale * (1 + (progress - 0.3) * 0.1));
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
                    rafId = requestAnimationFrame(animate);
                    this._trackRaf(rafId);
                } else {
                    this._untrackRaf(rafId);
                    // 变身完成时播放summon音效
                    this.audioManager.playSummon(0.7);
                    cell.ctx.globalAlpha = 1.0;
                    resolve();
                }
            };

            rafId = requestAnimationFrame(animate);
            this._trackRaf(rafId);
        });
    }

    // main.js - 修改syncGridWithGameBoard方法
    async syncGridWithGameBoard() {
        console.log('[同步] ========== 开始同步 ==========');
        
        if (!this.gameBoard) return;
        
        console.log('[同步] 当前游戏板状态:');
        const gridState = this.gameBoard.grid.map((p, i) => 
            `${i}:${p?.data?.name || '空'}`
        ).join(' ');
        console.log(`[同步] ${gridState}`);
        
        // 第一步：先处理进化
        const hasEvolution = await this.checkAndProcessEvolutions();
        if (hasEvolution) {
            await this.delay(500);
        }
        
        // 第二步：找出需要消除的格子
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
        
        // 第三步：处理消除，找到触发点
        if (cellsToClear.length > 0) {
            console.log(`[同步] 发现 ${cellsToClear.length} 个格子需要消除`);
            
            // 查找触发消除的格子（通常是新召唤的宝可梦）
            let triggerCell = null;
            if (this.lastSummonedIndex !== undefined) {
                triggerCell = this.gridCells[this.lastSummonedIndex];
            }
            
            if (cellsToClear.length === 2) {
                await this.playPairEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell,
                    triggerCell
                );
            } else if (cellsToClear.length === 3) {
                await this.playTripleEliminationAnimation(
                    cellsToClear[0].cell,
                    cellsToClear[1].cell,
                    cellsToClear[2].cell,
                    triggerCell
                );
            } else {
                for (const { cell } of cellsToClear) {
                    await this.playDisappearAnimation(cell);
                }
                // 捕获计数
                if (this.gameBoard && cellsToClear.length > 0) {
                    this.gameBoard.totalBallsAdded += cellsToClear.length;
                    this.updateBallCounter();
                }
            }
        }
        
        // 第四步：仅处理未动画化的奖励（进化等），rule 类型已由动画处理
        if (this.gameBoard.pendingRewards && this.gameBoard.pendingRewards.length > 0) {
            const remaining = this.gameBoard.pendingRewards.filter(r => r && r.type !== 'rule');
            if (remaining.length > 0) {
                console.log(`[同步] 处理剩余 ${remaining.length} 个非规则奖励`);
                for (const reward of remaining) {
                    if (reward.triggerIndex !== undefined) {
                        const triggerCell = this.gridCells[reward.triggerIndex];
                        if (triggerCell) {
                            await this.triggerImmediateReward(triggerCell, reward.balls);
                        }
                    }
                }
            }
            this.gameBoard.pendingRewards = [];
        }
        
        this.updateBallCounter();
        
        console.log('[同步] 同步完成');
        
        // 第五步：所有动画和奖励都完成后，再检查游戏是否结束
        // 等待一小会儿，确保所有状态都已更新
        await this.delay(200);
        
        if (this.gameBoard.checkGameEnd()) {
            this.gameOver();
        }
    }

    // main.js - 在checkAndProcessEvolutions中添加额外的安全判断
    async checkAndProcessEvolutions() {
        let hasEvolution = false;
        const evolutionAnimations = [];
        
        // 确保gameBoard和pendingRewards存在
        if (!this.gameBoard) return false;
        
        for (let i = 0; i < 9; i++) {
            const cell = this.gridCells[i];
            const gamePokemon = this.gameBoard.grid[i];
            const cellPokemon = cell.pokemon;
            
            if (gamePokemon && cellPokemon && gamePokemon !== cellPokemon) {
                if (this.isEvolution(cellPokemon, gamePokemon)) {
                    console.log(`[进化检测] 发现进化: 格子 ${i}, ${cellPokemon.data.name} -> ${gamePokemon.data.name}`);
                    
                    await this.imageLoader.loadPokemonImage(gamePokemon.data.id);
                    
                    // 查找进化奖励 - 添加安全判断
                    let rewardBalls = 0;
                    if (this.gameBoard.pendingRewards && Array.isArray(this.gameBoard.pendingRewards)) {
                        const evolutionReward = this.gameBoard.pendingRewards.find(r => 
                            r && r.type === 'evolution' && r.triggerIndex === i
                        );
                        if (evolutionReward) {
                            rewardBalls = evolutionReward.balls;
                            // 从pendingRewards中移除
                            this.gameBoard.pendingRewards = this.gameBoard.pendingRewards.filter(r => r !== evolutionReward);
                        }
                    }
                    
                    // 将进化动画加入队列
                    evolutionAnimations.push({
                        type: 'evolution',
                        data: { 
                            cell, 
                            newPokemon: gamePokemon,
                            rewardBalls: rewardBalls
                        }
                    });
                    
                    hasEvolution = true;
                }
            }
        }
        
        // 如果有进化动画，按顺序加入队列
        if (evolutionAnimations.length > 0) {
            for (const anim of evolutionAnimations) {
                this.queueAnimation(anim.type, anim.data);
            }
            await this.delay(evolutionAnimations.length * 1000);
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

    // 修改playEvolutionAnimation，添加summon音效 + rAF 追踪
    async playEvolutionAnimation(cell, newPokemon) {
        console.log(`[动画] 播放进化动画，格子 ${cell.index}: ${cell.pokemon?.data?.name} -> ${newPokemon.data.name}`);

        return new Promise(async (resolve) => {
            await this.imageLoader.loadPokemonImage(newPokemon.data.id);

            const newSprite = this.imageLoader.getPokemonSprite(
                newPokemon.data.id,
                newPokemon.isShiny,
                false
            );

            if (!newSprite) {
                console.error(`[动画] 无法获取新宝可梦精灵: ${newPokemon.data.id}`);
                cell.setPokemon(newPokemon, this.imageLoader);
                cell.updateDisplay();
                resolve();
                return;
            }

            const duration = 1200;
            const startTime = performance.now();
            let rafId;

            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);

                cell.ctx.clearRect(0, 0, cell.size, cell.size);

                if (progress < 0.3) {
                    if (Math.floor(progress * 20) % 2 === 0) {
                        cell.updateDisplay();
                    } else {
                        cell.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                        cell.ctx.fillRect(0, 0, cell.size, cell.size);
                    }
                } else if (progress < 0.6) {
                    const intensity = 0.8 - ((progress - 0.3) / 0.3) * 0.8;
                    cell.ctx.fillStyle = `rgba(255, 255, 255, ${intensity})`;
                    cell.ctx.fillRect(0, 0, cell.size, cell.size);

                    if (cell.sprite) {
                        cell.ctx.globalAlpha = 0.3;
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
                        cell.ctx.globalAlpha = 1.0;
                    }
                } else if (progress < 0.8) {
                    const whiteIntensity = 0.8 - ((progress - 0.6) / 0.2) * 0.8;
                    cell.ctx.fillStyle = `rgba(255, 255, 255, ${whiteIntensity})`;
                    cell.ctx.fillRect(0, 0, cell.size, cell.size);

                    if (newSprite) {
                        const newAlpha = ((progress - 0.6) / 0.2);
                        cell.ctx.globalAlpha = newAlpha;

                        if (newPokemon.currentTypes && newPokemon.currentTypes[0]) {
                            const mainType = newPokemon.currentTypes[0];
                            const typeColor = cell.typeColors[mainType] || '#A8A878';
                            cell.ctx.fillStyle = `${typeColor}66`;
                            cell.ctx.globalAlpha = newAlpha * 0.4;
                            cell.ctx.fillRect(0, 0, cell.size, cell.size);

                            cell.ctx.strokeStyle = typeColor;
                            cell.ctx.lineWidth = 3;
                            cell.ctx.globalAlpha = newAlpha;
                            cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
                            cell.ctx.globalAlpha = newAlpha;
                        }

                        const maxSize = cell.size * 0.7;
                        const scale = maxSize / Math.max(newSprite.width, newSprite.height);
                        cell.ctx.save();
                        cell.ctx.translate(cell.size / 2, cell.size / 2);
                        cell.ctx.scale(scale, scale);
                        cell.ctx.drawImage(
                            newSprite,
                            -newSprite.width / 2,
                            -newSprite.height / 2
                        );
                        cell.ctx.restore();
                        cell.ctx.globalAlpha = 1.0;
                    }
                } else {
                    cell.pokemon = newPokemon;
                    cell.sprite = newSprite;
                    cell.updateDisplay();
                }

                if (progress < 1) {
                    rafId = requestAnimationFrame(animate);
                    this._trackRaf(rafId);
                } else {
                    this._untrackRaf(rafId);
                    cell.pokemon = newPokemon;
                    cell.sprite = newSprite;
                    cell.updateDisplay();

                    // 进化完成时播放summon音效
                    this.audioManager.playSummon(0.7);

                    if (newPokemon.isShiny) {
                        setTimeout(() => {
                            this.playShinyEffect(cell, resolve);
                        }, 300);
                    } else {
                        resolve();
                    }
                }
            };

            rafId = requestAnimationFrame(animate);
            this._trackRaf(rafId);
        });
    }

    // 修改playDisappearAnimation，添加clear音效 + rAF 追踪
    async playDisappearAnimation(cell) {
        console.log(`[动画] 播放消失动画，格子 ${cell.index}`);

        // 播放消除音效
        this.audioManager.playClear(0.6);

        return new Promise((resolve) => {
            const duration = 350;
            const startTime = performance.now();

            const originalSprite = cell.sprite;
            let rafId;

            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);

                cell.ctx.clearRect(0, 0, cell.size, cell.size);

                // 先绘制空格子背景
                cell.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
                cell.ctx.fillRect(0, 0, cell.size, cell.size);

                cell.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
                cell.ctx.lineWidth = 2;
                cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);

                // 在上面绘制宝可梦，并让它淡出
                if (originalSprite) {
                    const scale = 1 - progress * 0.8;
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
                    rafId = requestAnimationFrame(animate);
                    this._trackRaf(rafId);
                } else {
                    this._untrackRaf(rafId);
                    cell.clear();
                    resolve();
                }
            };

            rafId = requestAnimationFrame(animate);
            this._trackRaf(rafId);
        });
    }

    // main.js - 修改playPairEliminationAnimation
    async playPairEliminationAnimation(cell1, cell2, triggerCell = null) {
        console.log(`[动画] 播放对对碰消除动画，格子 ${cell1.index} 和 ${cell2.index}`);

        await Promise.all([
            this.playDisappearAnimation(cell1),
            this.playDisappearAnimation(cell2)
        ]);

        // 消除奖励：精灵球 +1
        const sourceCell = triggerCell || cell1;
        console.log(`[消除奖励] 从格子 ${sourceCell.index} 飞出精灵球`);
        await this.triggerImmediateReward(sourceCell, 1);

        // 捕获计数：2 只宝可梦被消除，累积获得 +2
        if (this.gameBoard) {
            this.gameBoard.totalBallsAdded += 2;
            this.updateBallCounter();
        }
    }


    // main.js - 修复playDirectSummonAnimation方法（Canvas 复用池 + rAF 追踪）
    async playDirectSummonAnimation(cell, pokemonInstance) {
        const ballImage = await this.imageLoader.loadBallImage();

        console.log(`播放召唤动画，格子 ${cell.index}`);

        return new Promise((resolve) => {
            // 获取扔球按钮的位置
            const throwBtn = this.throwBtn;
            const btnRect = throwBtn.getBoundingClientRect();

            // 精灵球起始位置（扔球按钮的中心）
            const startX = btnRect.left + btnRect.width / 2;
            const startY = btnRect.top + btnRect.height / 2;

            // 目标位置是格子中心
            const endPos = cell.getCenterPosition();

            // 性能优化：使用复用的飞球 Canvas 代替每次创建
            const { canvas: flyCanvas, ctx: flyCtx } = this._getFlyCanvas();

            const duration = 800;
            const startTime = performance.now();
            const ballScale = 1.5;
            let rafId;

            const animate = () => {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);

                const easeProgress = 1 - Math.pow(1 - progress, 2);

                const controlX = (startX + endPos.x) / 2;
                const controlY = Math.min(startY, endPos.y) - 100;

                const x = Math.pow(1 - easeProgress, 2) * startX +
                        2 * (1 - easeProgress) * easeProgress * controlX +
                        Math.pow(easeProgress, 2) * endPos.x;

                const y = Math.pow(1 - easeProgress, 2) * startY +
                        2 * (1 - easeProgress) * easeProgress * controlY +
                        Math.pow(easeProgress, 2) * endPos.y;

                const rotation = progress * 720;
                const scale = ballScale * (1 - progress * 0.3);

                flyCtx.clearRect(0, 0, 50, 50);

                flyCtx.save();
                flyCtx.translate(25, 25);
                flyCtx.rotate(rotation * Math.PI / 180);
                flyCtx.drawImage(
                    ballImage,
                    -ballImage.width * scale / 2,
                    -ballImage.height * scale / 2,
                    ballImage.width * scale,
                    ballImage.height * scale
                );
                flyCtx.restore();

                flyCanvas.style.left = `${x - 25}px`;
                flyCanvas.style.top = `${y - 25}px`;

                if (progress < 1) {
                    rafId = requestAnimationFrame(animate);
                    this._trackRaf(rafId);
                } else {
                    this._untrackRaf(rafId);
                    this._releaseFlyCanvas();

                    // 召唤完成时播放summon音效
                    this.audioManager.playSummon(0.7);

                    // 重要：先设置宝可梦数据，再播放出现动画
                    cell.setPokemon(pokemonInstance, this.imageLoader);

                    // 确保格子是空的，然后播放出现动画
                    cell.ctx.clearRect(0, 0, cell.size, cell.size);

                    // 播放宝可梦出现动画
                    this.playPokemonAppearAnimation(cell, () => {
                        resolve();
                    });
                }
            };

            rafId = requestAnimationFrame(animate);
            this._trackRaf(rafId);
        });
    }


    // main.js - 不使用setTimeout的版本 + rAF 追踪
    playPokemonAppearAnimation(cell, onComplete) {
        console.log(`[动画] 宝可梦出现动画，格子 ${cell.index}`);

        // 检查sprite是否已设置
        if (!cell.sprite) {
            console.warn(`[动画] 格子 ${cell.index} 没有精灵图片，直接显示`);
            cell.updateDisplay();
            if (onComplete) onComplete();
            return;
        }

        const sprite = cell.sprite;
        const duration = 500;
        const startTime = performance.now();
        let rafId;

        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            const easeProgress = 1 - Math.pow(1 - progress, 2);
            const scale = 0.1 + (0.9 * easeProgress);

            cell.ctx.clearRect(0, 0, cell.size, cell.size);

            // 绘制背景
            if (cell.pokemon && cell.pokemon.currentTypes && cell.pokemon.currentTypes[0]) {
                const mainType = cell.pokemon.currentTypes[0];
                const typeColor = cell.typeColors[mainType] || '#A8A878';

                const r = parseInt(typeColor.slice(1, 3), 16);
                const g = parseInt(typeColor.slice(3, 5), 16);
                const b = parseInt(typeColor.slice(5, 7), 16);

                cell.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${easeProgress * 0.4})`;
                cell.ctx.fillRect(0, 0, cell.size, cell.size);

                cell.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${easeProgress})`;
                cell.ctx.lineWidth = 3;
                cell.ctx.strokeRect(2, 2, cell.size - 4, cell.size - 4);
            }

            // 绘制宝可梦
            const maxSize = cell.size * 0.7;
            const baseScale = maxSize / Math.max(sprite.width, sprite.height);

            cell.ctx.save();
            cell.ctx.translate(cell.size / 2, cell.size / 2);
            cell.ctx.scale(scale * baseScale, scale * baseScale);
            cell.ctx.globalAlpha = easeProgress;
            cell.ctx.drawImage(
                sprite,
                -sprite.width / 2,
                -sprite.height / 2
            );
            cell.ctx.restore();

            if (progress < 1) {
                rafId = requestAnimationFrame(animate);
                this._trackRaf(rafId);
            } else {
                this._untrackRaf(rafId);
                cell.updateDisplay();
                if (onComplete) onComplete();
            }
        };

        rafId = requestAnimationFrame(animate);
        this._trackRaf(rafId);
    }

    // 修改现有的playShinyEffect方法 + rAF 追踪
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
        let rafId;

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
                rafId = requestAnimationFrame(animate);
                this._trackRaf(rafId);
            } else {
                this._untrackRaf(rafId);
                // 特效完成
                cell.updateDisplay();
                if (onComplete) onComplete();
            }
        };

        rafId = requestAnimationFrame(animate);
        this._trackRaf(rafId);
    }

    // 修改updateBallCounter方法，更新新的计数显示（含缩放效果）
    updateBallCounter() {
        if (!this.gameBoard) return;

        // 更新精灵球数量显示
        if (this.ballCountSpan) {
            this.ballCountSpan.textContent = this.gameBoard.ballsRemaining;
        }

        // 更新累计获得显示
        if (this.totalBallsSpan) {
            var prev = this.totalBallsSpan.textContent;
            this.totalBallsSpan.textContent = this.gameBoard.totalBallsAdded;
            // 数值变化时播放缩放效果
            if (prev !== String(this.gameBoard.totalBallsAdded)) {
                this._pulseElement(this.totalBallsSpan);
            }
        }
    }

    // 缩放脉冲效果
    _pulseElement(el) {
        el.style.transition = 'transform 0.15s ease-out';
        el.style.transform = 'scale(1.4)';
        setTimeout(function() {
            el.style.transform = 'scale(1)';
        }, 150);
    }

    // main.js - 在initUI方法中调整顺序
    initUI() {
        const container = document.getElementById('game-container');
        if (!container) return;
        
        this.container = container;
        
        // 清空容器
        container.innerHTML = '';
        
        // ========== 顶部标题 ==========
        const title = document.createElement('div');
        title.className = 'game-title';
        title.textContent = '宝可梦对对碰';
        container.appendChild(title);
        
        // ========== 信息栏 ==========
        const infoBar = document.createElement('div');
        infoBar.className = 'info-bar';
        container.appendChild(infoBar);
        
        // 精灵球数量行
        const ballRow = document.createElement('div');
        ballRow.style.display = 'flex';
        ballRow.style.alignItems = 'center';
        ballRow.style.marginBottom = '8px';
        infoBar.appendChild(ballRow);
        
        const ballIcon = document.createElement('span');
        ballIcon.textContent = '';
        ballIcon.style.fontSize = 'min(24px, 6vw)';
        ballIcon.style.marginRight = '10px';
        ballIcon.style.color = '#FF4444';
        ballRow.appendChild(ballIcon);
        
        const ballLabel = document.createElement('span');
        ballLabel.textContent = '精灵球：';
        ballLabel.style.color = 'white';
        ballLabel.style.fontSize = 'min(16px, 4vw)';
        ballLabel.style.fontWeight = '500';
        ballRow.appendChild(ballLabel);
        
        this.ballCountSpan = document.createElement('span');
        this.ballCountSpan.textContent = '9';
        this.ballCountSpan.style.color = '#FFD700';
        this.ballCountSpan.style.fontSize = 'min(20px, 5vw)';
        this.ballCountSpan.style.fontWeight = 'bold';
        this.ballCountSpan.style.marginLeft = '5px';
        ballRow.appendChild(this.ballCountSpan);
        
        // 累计捕获行
        const captureRow = document.createElement('div');
        captureRow.style.display = 'flex';
        captureRow.style.alignItems = 'center';
        infoBar.appendChild(captureRow);
        
        const captureIcon = document.createElement('span');
        captureIcon.textContent = '';
        captureIcon.style.fontSize = 'min(20px, 5vw)';
        captureIcon.style.marginRight = '10px';
        captureIcon.style.color = '#FFD700';
        captureRow.appendChild(captureIcon);
        
        const captureLabel = document.createElement('span');
        captureLabel.textContent = '累计获得：';
        captureLabel.style.color = 'white';
        captureLabel.style.fontSize = 'min(15px, 4vw)';
        captureLabel.style.fontWeight = '500';
        captureRow.appendChild(captureLabel);
        
        this.totalBallsSpan = document.createElement('span');
        this.totalBallsSpan.textContent = '0';
        this.totalBallsSpan.style.color = '#81C784';
        this.totalBallsSpan.style.fontSize = 'min(18px, 4.5vw)';
        this.totalBallsSpan.style.fontWeight = 'bold';
        this.totalBallsSpan.style.marginLeft = '5px';
        captureRow.appendChild(this.totalBallsSpan);
        
        // ========== 九宫格场地 ==========
        this.createGameGrid();
        
        // ========== 命定属性栏 ==========
        const typeBar = document.createElement('div');
        typeBar.style.width = '100%';
        typeBar.style.maxWidth = 'min(400px, 90vw)';
        typeBar.style.margin = 'min(15px, 2vh) auto';
        typeBar.style.display = 'flex';
        typeBar.style.justifyContent = 'center';
        typeBar.style.alignItems = 'center';
        container.appendChild(typeBar);
        
        this.typeSelectBtn = this.createTypeSelectButton();
        typeBar.appendChild(this.typeSelectBtn);
        
        // ========== 游戏日志（暂时创建但隐藏）==========
        const logContainer = document.createElement('div');
        logContainer.style.width = '100%';
        logContainer.style.maxWidth = 'min(400px, 90vw)';
        logContainer.style.margin = '0 auto';
        logContainer.style.flex = '1';
        logContainer.style.minHeight = '0';
        logContainer.style.display = 'flex';
        logContainer.style.flexDirection = 'column';
        logContainer.style.display = 'none'; // 隐藏
        container.appendChild(logContainer);
        
        const logTitle = document.createElement('div');
        logTitle.textContent = '📋 游戏日志';
        logTitle.style.color = '#FFD700';
        logTitle.style.fontSize = 'min(16px, 4vw)';
        logTitle.style.fontWeight = 'bold';
        logTitle.style.marginBottom = '5px';
        logTitle.style.paddingLeft = '5px';
        logContainer.appendChild(logTitle);
        
        // 创建messageBoard，即使隐藏也要创建，避免空指针
        this.messageBoard = new MessageBoard(0, 0, 400, 140);
        const messageElement = this.messageBoard.getElement();
        messageElement.style.position = 'relative';
        messageElement.style.width = '100%';
        messageElement.style.height = 'min(140px, 20vh)';
        messageElement.style.left = '0';
        messageElement.style.top = '0';
        messageElement.style.background = 'rgba(0, 0, 0, 0.7)';
        messageElement.style.borderRadius = '12px';
        messageElement.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        messageElement.style.backdropFilter = 'blur(5px)';
        logContainer.appendChild(messageElement);
        
        // main.js - 在initUI方法中修改按钮栏的margin
        // ========== 操作按钮 ==========
        const buttonBar = document.createElement('div');
        buttonBar.style.width = '100%';
        buttonBar.style.maxWidth = 'min(400px, 90vw)';
        buttonBar.style.margin = 'min(15px, 2vh) auto max(env(safe-area-inset-bottom, 25px), 25px) auto'; // 使用max确保底部边距
        buttonBar.style.display = 'flex';
        buttonBar.style.justifyContent = 'center';
        buttonBar.style.gap = 'min(20px, 4vw)';
        buttonBar.style.padding = '0 min(10px, 2vw)';
        buttonBar.style.boxSizing = 'border-box';
        container.appendChild(buttonBar);
        
        const throwBtn = this.createButton('扔球', () => this.summonPokemon());
        throwBtn.style.flex = '1';
        throwBtn.style.maxWidth = 'min(160px, 40vw)';
        throwBtn.style.background = 'linear-gradient(45deg, #2196F3, #21CBF3)';
        buttonBar.appendChild(throwBtn);
        
        const restartBtn = this.createButton('重新开始', () => this.restartGame());
        restartBtn.style.flex = '1';
        restartBtn.style.maxWidth = 'min(160px, 40vw)';
        restartBtn.style.background = 'linear-gradient(45deg, #FF6B6B, #FF8E8E)';
        buttonBar.appendChild(restartBtn);
        
        this.throwBtn = throwBtn;
        this.restartBtn = restartBtn;
        
        this.setGameStartState(false);
        
        // UI创建完成后，可以安全地显示消息
        setTimeout(() => {
            if (this.messageBoard) {
                this.logMessage('系统', '界面加载完成');
            }
        }, 500);
    }

    // 添加更新格子大小的方法
    updateGridSize() {
        if (!this.gridWrapper || !this.gridCells) return;
        
        this.gridCells.forEach((cell, index) => {
            const row = Math.floor(index / 3);
            const col = index % 3;
            const cellContainer = this.gridWrapper.children[row * 3 + col];
            if (cellContainer) {
                const rect = cellContainer.getBoundingClientRect();
                const newSize = Math.min(rect.width, rect.height);
                if (newSize > 0) {
                    cell.size = newSize;
                    cell.canvas.width = newSize;
                    cell.canvas.height = newSize;
                    cell.updateDisplay();
                }
            }
        });
    }

// main.js - 修复createGameGrid方法
createGameGrid() {
    const container = this.container;
    
    // 创建九宫格外容器 - 使用CSS Grid布局
    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'grid-wrapper';
    gridWrapper.style.width = '100%';
    gridWrapper.style.maxWidth = 'min(400px, 90vw)';
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
            
            // 创建格子容器 - 作为grid的子元素
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
            
            // 创建PokemonCell
            const cell = new PokemonCell(index, cellContainer, 0);
            this.gridCells.push(cell);
        }
    }
    
    // 延迟获取格子大小
    setTimeout(() => {
        this.updateGridSize();
    }, 100);
    
    // 监听窗口大小变化
    window.addEventListener('resize', () => {
        this.updateGridSize();
    });
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
        button.textContent = this.selectedType ? `命定属性：${this.selectedType}` : '点击选择命定属性';
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
                    this.typeSelectBtn.textContent = '点击选择命定属性';
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

    // gameOver — 游戏结束时依次消除场上宝可梦
    async gameOver() {
        if (this.isGameOver) return;

        this.isGameOver = true;
        this.logMessage('游戏结束', '精灵球已用完，游戏结束！');

        // BGM淡出
        this.audioManager.fadeOutBGM(3000);

        // 收集场上所有有宝可梦的格子
        const activeCells = this.gridCells.filter(cell => cell.pokemon);
        if (activeCells.length > 0) {
            this.logMessage('系统', `场上有 ${activeCells.length} 只宝可梦，正在回收...`);

            // 依次消除每个格子，每次 +1 捕获计数
            for (const cell of activeCells) {
                await this.playDisappearAnimation(cell);

                // 每回收一只宝可梦，累计获得 +1
                if (this.gameBoard) {
                    this.gameBoard.totalBallsAdded += 1;
                    this.updateBallCounter();
                }
            }

            this.logMessage('奖励', `回收宝可梦，累计捕获 +${activeCells.length}`);
            this.updateBallCounter();
        }

        // 显示最终统计
        const stats = this.gameBoard.getGameStats();

        this.logMessage('统计', '=== 游戏统计 ===');
        this.logMessage('统计', `总召唤次数: ${stats.totalSummons}`);
        this.logMessage('统计', `累计获得精灵球: ${stats.totalRewards}`);
        this.logMessage('统计', `累计捕获宝可梦: ${this.gameBoard.totalBallsAdded}`);
        this.logMessage('统计', `传说宝可梦出场: ${stats.legendarySummoned}`);
        this.logMessage('统计', `幻之宝可梦出场: ${stats.mythicalSummoned}`);

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

    // main.js - 修改restartGame方法
    restartGame() {
        console.log('重新开始游戏');

        // 性能优化：取消所有正在运行的动画
        this._cancelAllAnimations();

        this.isGameOver = false;
        this.isSummoning = false;
        this.gameStarted = false;
        this.bgmStarted = false; // 重置BGM标记

        // 清空动画队列
        this.animationQueue = [];
        this.isAnimating = false;
        this.pendingRewards = [];
        this.immediateRewards = [];

        // 清空消息
        this.messageBoard.clear();

        // 重新初始化游戏板
        const allTypes = this.pokemonData.getAllTypes();
        const chosenType = this.selectedType || allTypes[0];

        this.gameBoard = new GameBoard(
            this.pokemonData,
            chosenType,
            9,
            (type, message) => this.immediateLogMessage(type, message)
        );

        if (this.selectedType) {
            this.gameBoard.playerChosenType = this.selectedType;
        }

        this.gameBoard.setUICallback((type, message) => {
            this.immediateLogMessage(type, message);
        });

        this.initializeGridCells();
        this.updateBallCounter();

        this.setGameStartState(false);

        // 停止当前BGM
        this.audioManager.stopBGM();

        // 重新设置BGM自动播放（内部会先移除旧监听器）
        this.setupBGMAutoPlay();

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

    // main.js - 修改immediateLogMessage方法，添加空值检查
    immediateLogMessage(type, message, triggerIndex = null) {
        console.log(`[UI显示] ${type}: ${message}`);
        
        // 如果messageBoard不存在，只输出到控制台
        if (!this.messageBoard) {
            console.log(`[MessageBoard未创建] ${type}: ${message}`);
            return;
        }
        
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
            case '行动':
                color = '#A0A0A0';
                break;
        }
        
        try {
            this.messageBoard.addMessage(displayType, message, color);
        } catch (error) {
            console.error('添加消息到消息板失败:', error);
        }
        
        // 如果是规则奖励且有触发位置，播放精灵球飞行动画
        if (type === '规则奖励' && triggerIndex !== null) {
            const triggerCell = this.gridCells[triggerIndex];
            if (triggerCell) {
                setTimeout(() => {
                    this.playBallFlyAnimation(triggerCell);
                }, 100);
            }
        }
    }

    // main.js - 修改logMessage方法
    logMessage(type, message) {
        // 如果messageBoard存在，才显示
        if (this.messageBoard) {
            this.immediateLogMessage(type, message);
        } else {
            console.log(`[日志暂存] ${type}: ${message}`);
        }
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

    // 修改playBallFlyAnimation，添加point音效（Canvas 复用池 + rAF 追踪）
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

        console.log(`[动画] 精灵球飞行: +${rewardBalls}球, 从格子 ${startCell.index}`);

        return new Promise((resolve) => {
            const duration = 800;
            const startTime = performance.now();
            const ballScale = 1.2;

            // 性能优化：使用复用的飞球 Canvas
            const { canvas: flyCanvas, ctx: flyCtx } = this._getFlyCanvas();

            // 标记是否已经加过球
            let ballAdded = false;
            let rafId;

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

                // 在精灵球接近终点时加球并播放音效
                if (!ballAdded && progress > 0.9) {
                    ballAdded = true;

                    // 播放point音效（精灵球飞到计数点）
                    this.audioManager.playPoint(0.5);

                    if (this.gameBoard) {
                        this.gameBoard.ballsRemaining += rewardBalls;
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
                    rafId = requestAnimationFrame(animate);
                    this._trackRaf(rafId);
                } else {
                    this._untrackRaf(rafId);
                    this._releaseFlyCanvas();
                    resolve();
                }
            };

            rafId = requestAnimationFrame(animate);
            this._trackRaf(rafId);
        });
    }

    // main.js - 修改processPendingRewards方法
    async processPendingRewards() {
        if (!this.gameBoard || !this.gameBoard.pendingRewards) return;
        
        // 按时间戳排序，确保顺序
        const rewards = [...this.gameBoard.pendingRewards].sort((a, b) => a.order - b.order);
        this.gameBoard.pendingRewards = [];
        
        console.log(`[奖励] 开始顺序处理 ${rewards.length} 个奖励`);
        
        // 将所有奖励动画加入队列
        for (let i = 0; i < rewards.length; i++) {
            const reward = rewards[i];
            const ballCount = parseInt(reward.balls) || 1;
            
            if (reward.triggerIndex !== null && reward.triggerIndex !== undefined) {
                const triggerCell = this.gridCells[reward.triggerIndex];
                if (triggerCell && triggerCell.isActive) {
                    console.log(`[奖励] 从格子 ${reward.triggerIndex} 飞出 ${ballCount} 个精灵球 (${reward.type})`);
                    this.queueAnimation('ballFly', {
                        cell: triggerCell,
                        balls: ballCount
                    });
                } else {
                    // 如果触发格子已消除，找其他格子
                    for (let j = 0; j < this.gridCells.length; j++) {
                        if (this.gridCells[j].pokemon) {
                            this.queueAnimation('ballFly', {
                                cell: this.gridCells[j],
                                balls: ballCount
                            });
                            break;
                        }
                    }
                }
            } else {
                // 没有触发位置，找第一个有宝可梦的格子
                for (let j = 0; j < this.gridCells.length; j++) {
                    if (this.gridCells[j].pokemon) {
                        this.queueAnimation('ballFly', {
                            cell: this.gridCells[j],
                            balls: ballCount
                        });
                        break;
                    }
                }
            }
        }
        
        console.log(`[奖励] 所有奖励已加入队列`);
    }
}

// 启动游戏
const game = new VisualGame();

window.addEventListener('resize', () => {
    console.log('窗口大小变化，需要重新布局');
});