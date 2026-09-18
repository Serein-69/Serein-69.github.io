const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

// 本地白名单存储文件
const DB_FILE = path.join(__dirname, 'whitelist_db.json');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 初始化白名单数据
function getWhitelistData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {}
    // 默认内置初始白名单
    return [
        { id: 1, steam_id: "76561198213992509", note: "Author", created_at: new Date().toLocaleString() },
        { id: 2, steam_id: "76561198403252142", note: "Author", created_at: new Date().toLocaleString() },
        { id: 3, steam_id: "76561198101573918", note: "Author", created_at: new Date().toLocaleString() }
    ];
}

function saveWhitelistData(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("Save failed:", e);
    }
}

// 1. 健康检测
app.get(['/', '/api/health'], (req, res) => {
    res.json({ status: "success", message: "Genesis Vercel API running perfectly!", time: new Date().toISOString() });
});

// 2. 版本检测
app.get('/api/genesis/version', (req, res) => {
    res.json({
        status: "success",
        latestVersion: "2.5",
        downloadUrl: `https://${req.get('host')}/downloads/ItemInspectorMod.dll`,
        changelog: "1. 全新 Vercel 国内免翻极速节点\n2. 修复多页仓库跨页存仓\n3. 官方级装备品阶映射"
    });
});

// 3. 白名单列表接口 (纯文本返回，每行一个 SteamID)
app.get('/api/genesis/whitelist', (req, res) => {
    const list = getWhitelistData().map(r => r.steam_id).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(list);
});

// 4. 网页端白名单管理后台 (/admin/whitelist)
app.get('/admin/whitelist', (req, res) => {
    const rows = getWhitelistData();
    const listHtml = rows.map(r => `
        <tr>
            <td style="padding:8px; border:1px solid #333;">${r.id}</td>
            <td style="padding:8px; border:1px solid #333; font-family:monospace; font-weight:bold; color:#00ff66;">${r.steam_id}</td>
            <td style="padding:8px; border:1px solid #333;">${r.note || ''}</td>
            <td style="padding:8px; border:1px solid #333; font-size:12px; color:#888;">${r.created_at}</td>
            <td style="padding:8px; border:1px solid #333;">
                <form method="POST" action="/admin/whitelist/delete" style="display:inline;" onsubmit="return confirm('确定删除该白名单?');">
                    <input type="hidden" name="secret" value="${SERVER_SECRET_KEY}">
                    <input type="hidden" name="steamId" value="${r.steam_id}">
                    <button type="submit" style="background:#ff4444; color:#fff; border:none; padding:4px 8px; cursor:pointer; border-radius:3px;">删除</button>
                </form>
            </td>
        </tr>
    `).join("");

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>创世纪战 · 白名单管理后台</title></head>
        <body style="background:#121620; color:#fff; font-family:sans-serif; padding:20px; max-width:850px; margin:auto;">
            <h2>创世纪战 · 云端白名单实时管理后台 (Vercel 国内免翻直连)</h2>
            <div style="background:#1c2230; padding:15px; border-radius:6px; margin-bottom:20px;">
                <h3>添加新白名单 (支持多行批量粘贴)</h3>
                <form method="POST" action="/admin/whitelist/add">
                    <input type="hidden" name="secret" value="${SERVER_SECRET_KEY}">
                    <p><label>SteamID (每行一个):</label><br>
                    <textarea name="steamIds" rows="5" style="width:100%; box-sizing:border-box; background:#0a0d14; color:#00ff66; border:1px solid #444; padding:8px; font-family:monospace;" placeholder="76561198213992509&#10;76561198403252142" required></textarea></p>
                    <p><label>备注信息 (可选):</label><br>
                    <input type="text" name="note" style="width:100%; box-sizing:border-box; background:#0a0d14; color:#fff; border:1px solid #444; padding:8px;" placeholder="例如: 客户A"></p>
                    <button type="submit" style="background:#00bb44; color:#fff; font-size:14px; font-weight:bold; border:none; padding:8px 20px; cursor:pointer; border-radius:4px;">确认添加至白名单</button>
                </form>
            </div>
            <h3>当前已授权白名单列表 (共 ${rows.length} 人)</h3>
            <table style="width:100%; border-collapse:collapse; background:#1c2230;">
                <thead><tr style="background:#252d3d; text-align:left;">
                    <th style="padding:8px; border:1px solid #333;">ID</th>
                    <th style="padding:8px; border:1px solid #333;">SteamID</th>
                    <th style="padding:8px; border:1px solid #333;">备注</th>
                    <th style="padding:8px; border:1px solid #333;">添加时间</th>
                    <th style="padding:8px; border:1px solid #333;">操作</th>
                </tr></thead>
                <tbody>${listHtml || '<tr><td colspan="5" style="padding:15px; text-align:center; color:#888;">暂无数据</td></tr>'}</tbody>
            </table>
        </body>
        </html>
    `);
});

app.post('/admin/whitelist/add', (req, res) => {
    const secret = req.body.secret;
    if (secret !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden");

    const rawIds = req.body.steamIds || "";
    const note = req.body.note || "Web Add";
    const idList = String(rawIds).split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);

    const data = getWhitelistData();
    for (const id of idList) {
        if (/^\d{16,20}$/.test(id) && !data.some(r => r.steam_id === id)) {
            data.push({
                id: data.length + 1,
                steam_id: id,
                note: String(note).trim(),
                created_at: new Date().toLocaleString()
            });
        }
    }
    saveWhitelistData(data);
    res.redirect('/admin/whitelist');
});

app.post('/admin/whitelist/delete', (req, res) => {
    const secret = req.body.secret;
    if (secret !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden");

    const steamId = req.body.steamId;
    let data = getWhitelistData();
    data = data.filter(r => r.steam_id !== steamId);
    saveWhitelistData(data);
    res.redirect('/admin/whitelist');
});

// Vercel Serverless 需要导出 app
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}
