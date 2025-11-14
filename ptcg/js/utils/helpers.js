import { CONFIG } from './constants.js';

// Three.js 背景初始化
export function initThreeJS() {
    const container = document.getElementById('three-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 5;
    
    const renderer = new THREE.WebGLRenderer({ alpha: true });
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    const pointLight = new THREE.PointLight(0xffffff, 1);
    pointLight.position.set(10, 10, 10);
    scene.add(pointLight);
    
    const particlesGeometry = new THREE.BufferGeometry();
    const particlesCount = 100;
    const posArray = new Float32Array(particlesCount * 3);
    
    for (let i = 0; i < particlesCount * 3; i++) {
        posArray[i] = (Math.random() - 0.5) * 20;
    }
    
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.1,
        color: 0xFFCC00
    });
    
    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);
    
    function animate() {
        requestAnimationFrame(animate);
        particlesMesh.rotation.x += 0.001;
        particlesMesh.rotation.y += 0.001;
        renderer.render(scene, camera);
    }
    
    animate();
    
    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    });
}

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

// 显示成功消息
export function showSaveSuccess(message) {
    const successMsg = document.createElement('div');
    successMsg.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(76, 175, 80, 0.95);
        color: white;
        padding: 20px 30px;
        border-radius: 10px;
        font-size: 1.2rem;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    `;
    successMsg.textContent = message;
    
    document.body.appendChild(successMsg);
    
    setTimeout(() => {
        if (document.body.contains(successMsg)) {
            document.body.removeChild(successMsg);
        }
    }, 2000);
}

// 显示错误消息
export function showSaveError(message) {
    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(244, 67, 54, 0.9);
        color: white;
        padding: 20px 30px;
        border-radius: 10px;
        font-size: 1.2rem;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    `;
    errorMsg.textContent = message;
    
    document.body.appendChild(errorMsg);
    
    setTimeout(() => {
        document.body.removeChild(errorMsg);
    }, 3000);
}

// 生成图片文件名
export function generateImageFilename(id) {
    const paddedId = id.toString().padStart(8, '0');
    return `hk${paddedId}.webp`;
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