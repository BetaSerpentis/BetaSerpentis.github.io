const express = require('express');
const fileUpload = require('express-fileupload');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(fileUpload());

// 保存Excel数据的API
app.post('/api/save-excel', (req, res) => {
    try {
        if (!req.files || !req.files.excelData) {
            return res.status(400).json({ error: '没有接收到Excel数据' });
        }

        const excelData = req.files.excelData;
        const filePath = path.join(__dirname, 'data', '宝可梦卡.xlsx');
        
        // 保存文件
        excelData.mv(filePath, (err) => {
            if (err) {
                return res.status(500).json({ error: '文件保存失败' });
            }
            res.json({ success: true, message: '数据保存成功' });
        });
    } catch (error) {
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

// 获取Excel数据的API
app.get('/api/get-excel', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', '宝可梦卡.xlsx');
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Excel文件不存在' });
        }

        res.sendFile(filePath);
    } catch (error) {
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});