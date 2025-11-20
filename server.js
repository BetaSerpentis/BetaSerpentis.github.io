const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(fileUpload());

// 添加静态文件服务
app.use(express.static(path.join(__dirname)));

// 确保data目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// 保存JSON数据的API
app.post('/api/save-data', (req, res) => {
    try {
        // console.log('接收到保存请求');
        
        if (!req.body.cardData) {
            return res.status(400).json({ success: false, error: '没有接收到数据' });
        }

        const cardData = req.body.cardData;
        const filePath = path.join(__dirname, 'data', 'card-data.json');
        
        // console.log('保存数据到JSON文件...');
        
        // 直接保存为JSON
        fs.writeFileSync(filePath, JSON.stringify(cardData, null, 2), 'utf8');
        
        // console.log('JSON文件保存成功');
        res.json({ success: true, message: '数据保存成功' });
        
    } catch (error) {
        console.error('保存数据错误:', error);
        res.status(500).json({ success: false, error: '服务器错误: ' + error.message });
    }
});

// 获取JSON数据的API
app.get('/api/get-data', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'card-data.json');
        
        // console.log('读取JSON文件:', filePath);
        
        if (!fs.existsSync(filePath)) {
            // console.log('JSON文件不存在，返回空数据');
            return res.json([]);
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        const cardData = JSON.parse(fileContent);
        
        // console.log('成功读取JSON数据，条数:', cardData.length);
        res.json(cardData);
        
    } catch (error) {
        console.error('获取数据错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

// 兼容旧的Excel接口（可选）
app.get('/api/get-excel', (req, res) => {
    // 重定向到新的JSON接口
    res.redirect('/api/get-data');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    // console.log(`服务器运行在 http://localhost:${PORT}`);
});