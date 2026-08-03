import { CONFIG } from './constants.js';

// 防抖函数
export function debounce(func, wait = CONFIG.debounceTime) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/** 统一 Toast 通知
 * @param {string} message - 消息文本
 * @param {'success'|'error'|'info'} type - 类型
 * @param {number} [duration=2000] - 显示毫秒数
 */
export function showToast(message, type = 'success', duration = 2000) {
    const bgColor = type === 'error' ? 'rgba(244, 67, 54, 0.9)'
                  : type === 'info'  ? 'rgba(0, 0, 0, 0.8)'
                  : 'rgba(76, 175, 80, 0.95)';
    const el = document.createElement('div');
    el.style.cssText = `
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:${bgColor};color:white;padding:16px 28px;
        border-radius:10px;font-size:1.1rem;font-weight:bold;
        z-index:20000;box-shadow:0 4px 15px rgba(0,0,0,0.3);
    `;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { if (document.body.contains(el)) el.remove(); }, duration);
}

// 向下兼容的别名
export const showSaveSuccess = (msg, dur) => showToast(msg, 'success', dur);
export const showSaveError = (msg, dur) => showToast(msg, 'error', dur || 3000);

// 生成缩略图文件名（卡牌网格用，150px 宽）
// 新格式: 151C-001 → images/151C/001.thumb.webp
// 旧格式: 4521 → images/hk00004521.webp
export function generateImageFilename(id) {
    const str = String(id);
    if (str.includes('-')) {
        const [setCode, cardIndex] = str.split('-');
        return `images/${setCode}/${cardIndex}.thumb.webp`;
    }
    // Legacy fallback
    const paddedId = str.padStart(8, '0');
    return `images/hk${paddedId}.webp`;
}

// 生成完整大图文件名（卡牌详情弹窗用）
export function generateFullImageFilename(id) {
    const str = String(id);
    if (str.includes('-')) {
        const [setCode, cardIndex] = str.split('-');
        return `images/${setCode}/${cardIndex}.webp`;
    }
    const paddedId = str.padStart(8, '0');
    return `images/hk${paddedId}.webp`;
}

// 检查元素是否在视口中
export function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const windowHeight = window.innerHeight || document.documentElement.clientHeight;
    const windowWidth = window.innerWidth || document.documentElement.clientWidth;
    
    return (
        rect.top >= -rect.height &&
        rect.left >= -rect.width &&
        rect.bottom <= windowHeight + rect.height &&
        rect.right <= windowWidth + rect.width
    );
}

// 导出卡组数据
export function exportDeckData(decks) {
    const dataStr = JSON.stringify(decks, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ptcg-decks-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    showSaveSuccess(`已导出 ${decks.length} 个卡组数据`);
}

// 导入卡组数据
export function importDeckData(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = event => {
            try {
                const importedData = JSON.parse(event.target.result);
                callback(importedData);
            } catch (error) {
                console.error('导入卡组数据失败:', error);
                showSaveError('导入失败：文件格式不正确');
            }
        };
        
        reader.readAsText(file);
    };
    
    input.click();
}