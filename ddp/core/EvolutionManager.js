// EvolutionManager.js - 恢复到之前的简单版本
import { PokemonInstance } from './SummonSystem.js';

class EvolutionManager {
    constructor(pokemonData, gameBoard) {
        this.data = pokemonData;
        this.board = gameBoard;
    }

    // 每次召唤后检查所有宝可梦进化（原有逻辑）
    checkEvolutions() {
        const evolutionEvents = [];
        
        this.board.grid.forEach((pokemon, index) => {
            if (!pokemon || pokemon.isTransformed) return;
            
            const pokemonData = pokemon.data;
            if (!pokemonData.evolvesTo) return;
            
            // 万分比概率转小数
            const evolutionProb = pokemonData.evolutionProb;
            if (evolutionProb <= 0) return;
            
            // 判定进化
            if (Math.random() < evolutionProb) {
                const evolutionResult = this.evolvePokemon(index, pokemon);
                if (evolutionResult) {
                    evolutionEvents.push(evolutionResult);
                }
            }
        });
        
        return evolutionEvents;
    }

    // 原有的 evolvePokemon 方法保持不变
    evolvePokemon(index, pokemonInstance) {
        const newPokemonId = pokemonInstance.data.evolvesTo;
        const newPokemonData = this.data.getPokemonById(newPokemonId);
        
        if (!newPokemonData) {
            console.error(`进化目标不存在: ID ${newPokemonId}`);
            return null;
        }
        
        console.log(`进化: ${pokemonInstance.data.name} -> ${newPokemonData.name}`);
        
        // 创建进化后的实例，继承异色状态
        const evolvedInstance = new PokemonInstance(newPokemonData, index);
        evolvedInstance.isShiny = pokemonInstance.isShiny;
        evolvedInstance.hasTriggeredChosenType = false;
        
        // 替换场上宝可梦
        this.board.grid[index] = evolvedInstance;
        
        // 根据进化阶段给予奖励
        let rewardBalls = 0;
        if (newPokemonData.stage === '一阶进化') {
            rewardBalls = 1;
        } else if (newPokemonData.stage === '二阶进化') {
            rewardBalls = 2;
        }
        
        return {
            oldPokemon: pokemonInstance.data.name,
            newPokemon: newPokemonData.name,
            index: index,
            rewardBalls: rewardBalls,
            isShiny: evolvedInstance.isShiny
        };
    }
}

export default EvolutionManager;