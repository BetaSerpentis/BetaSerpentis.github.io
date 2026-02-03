// main.js
import PokemonData from './core/PokemonData.js';
import GameBoard from './core/GameBoard.js';

class ConsoleGame {
  constructor() {
    this.pokemonData = new PokemonData();
    this.gameBoard = null;
    this.isGameRunning = false;
  }

  async init() {
    console.log('=== 宝可梦对对碰 - 控制台测试版 ===');
    
    try {
      // 加载数据
      const loaded = await this.pokemonData.loadData('./data/pokemon_config.json');
      if (!loaded) {
        console.error('无法加载宝可梦数据，请检查data/pokemon_config.json文件');
        return;
      }

      // 选择属性
      const allTypes = this.pokemonData.getAllTypes();
      console.log(`可用属性: ${allTypes.join(', ')}`);
      
      // 这里简化：默认选择第一个属性
      const chosenType = allTypes[0];
      console.log(`自动选择属性: ${chosenType}`);
      
      // 初始化游戏板
      this.gameBoard = new GameBoard(this.pokemonData, chosenType, 9);
      this.isGameRunning = true;
      
      console.log('\n输入命令:');
      console.log('  "s" - 召唤宝可梦');
      console.log('  "r" - 显示场地');
      console.log('  "q" - 退出游戏');
      console.log('  "stats" - 显示统计');
      
      // 开始游戏循环
      this.gameLoop();
      
    } catch (error) {
      console.error('游戏初始化失败:', error);
    }
  }

  async gameLoop() {
    // 简化：这里我们让游戏自动运行10次召唤
    for (let i = 0; i < 10 && this.isGameRunning; i++) {
      console.log(`\n--- 第${i+1}次召唤 ---`);
      this.gameBoard.summonPokemon();
      
      // 模拟延迟
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 显示最终统计
    this.showStats();
  }

  showStats() {
    if (!this.gameBoard) return;
    
    const stats = this.gameBoard.getGameStats();
    console.log('\n=== 游戏统计 ===');
    console.log(`总召唤次数: ${stats.totalSummons}`);
    console.log(`累计获得精灵球: ${stats.totalRewards}`);
    console.log(`传说宝可梦出场: ${stats.legendarySummoned}`);
    console.log(`幻之宝可梦出场: ${stats.mythicalSummoned}`);
    
    console.log('\n=== 游戏日志 ===');
    stats.gameLog.forEach(event => {
      console.log(`[${event.time}] ${event.type}: ${event.message}`);
    });
  }
}

// 启动游戏
const game = new ConsoleGame();
game.init();