import { debugLog } from './constants.js';

export class TouchManager {
    constructor() {
        this.initTouchPrevention();
    }
    
    initTouchPrevention() {
        // 防止双击缩放
        let lastTouchEnd = 0;
        const preventDoubleTapZoom = (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        };
        
        // 防止手势缩放
        const preventPinchZoom = (e) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        };
        
        // 应用事件监听
        document.addEventListener('touchend', preventDoubleTapZoom, { passive: false });
        document.addEventListener('touchstart', preventPinchZoom, { passive: false });
        
        // 禁用iOS双击放大
        document.documentElement.style.touchAction = 'manipulation';
        
        // 禁用iOS长按菜单
        document.documentElement.style.webkitTouchCallout = 'none';
        
        debugLog('✅ TouchManager: 移动端触摸事件防护已启用');
    }
    
    // 为特定元素启用触摸（用于输入框）
    enableTouchForElement(element) {
        if (element) {
            element.style.touchAction = 'auto';
            element.style.webkitTouchCallout = 'default';
            element.style.webkitUserSelect = 'auto';
        }
    }
}