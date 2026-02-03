// utils/excelToJson.js (Node.js环境运行)
const fs = require('fs');
const path = require('path');
// 需要先安装: npm install xlsx
const XLSX = require('xlsx');

function convertExcelToJson() {
  // 读取Excel文件
  const workbook = XLSX.readFile('宝可梦对对碰.xlsx');
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // 转换为JSON
  const data = XLSX.utils.sheet_to_json(worksheet);
  
  const result = {
    pokemons: [],
    typeColors: {
      "草": "#78C850",
      "火": "#F08030",
      "水": "#6890F0",
      "斗": "#C03028",
      "超": "#F85888",
      "恶": "#705848",
      "雷": "#F8D030",
      "钢": "#B8B8D0",
      "龙": "#7038F8",
      "无": "#A8A878"
    }
  };
  
  data.forEach(row => {
    const pokemon = {
      id: row['id'],
      name: row['宝可梦'],
      type1: row['属性1'] || null,
      type2: row['属性2'] || null,
      stage: row['阶段'],
      evolvesTo: row['进化后id'] || null,
      // 万分比转小数概率
      evolutionProb: row['进化概率'] ? row['进化概率'] / 10000 : 0,
      shinyProb: row['异色概率'] ? row['异色概率'] / 10000 : 0,
      // 1为true，否则false
      isLegendary: row['传说宝可梦'] === 1,
      isMythical: row['幻之宝可梦'] === 1,
      isTransformer: row['变身者'] === 1
    };
    
    result.pokemons.push(pokemon);
  });
  
  // 保存为JSON文件
  const jsonPath = path.join(__dirname, '../data/pokemon_config.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`转换完成！共${result.pokemons.length}只宝可梦，保存到: ${jsonPath}`);
}

convertExcelToJson();