// 应用主入口
document.addEventListener('DOMContentLoaded', function() {
    console.log('克苏鲁跑团助手初始化...');
    
    // 初始化各模块
    Roster.init();
    CharacterPage.init();
    
    console.log('应用初始化完成');
});