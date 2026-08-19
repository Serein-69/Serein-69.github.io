const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

// 🌟 管理员 SteamID 白名单（在此处填入你的 Steam64 位 ID）
const ADMIN_STEAM_IDS = [
    "76561199115475689", // 示例：填入你的真实 SteamID
];

app.use(cors());
app.use(express.json());

// 过滤名字里的 HTML/Color 标签
function cleanName(name) {
    if (!name) return "Unknown";
    return name.replace(/<[^>]*>/g, '').trim();
}

const dbPath = path.resolve(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('数据库连接失败:', err.message);
    else console.log('✅ SQLite 数据库已就绪 (leaderboard.db)');
});

// 初始化数据表
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT '🌐 未知',
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// 1. 获取排行榜
app.get('/api/leaderboard', (req, res) => {
    const query = `
        SELECT player_id, name, region, wins, matches, score,
               ROUND((CAST(wins AS FLOAT) / CAST(CASE WHEN matches = 0 THEN 1 ELSE matches END AS FLOAT)) * 100, 1) as winRate
        FROM players 
        ORDER BY score DESC 
        LIMIT 100
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows });
    });
});

// 2. 接收全房间战绩上报
app.post('/api/score', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "拒绝访问：秘钥错误！" });
    }

    const { playerId, name, region, isWin, scoreChange } = req.body;
    const pureName = cleanName(name);
    const winIncrement = isWin ? 1 : 0;
    const finalRegion = region || '🌐 未知';

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, 1, 1000 + ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = excluded.name,
            region = excluded.region,
            wins = players.wins + ?,
            matches = players.matches + 1,
            score = MAX(0, players.score + ?),
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [playerId, pureName, finalRegion, winIncrement, scoreChange || 0, winIncrement, scoreChange || 0], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        console.log(`🎮 [全员战绩入库] 玩家: ${pureName} (${playerId}), 变动: ${scoreChange}, 胜负: ${isWin ? "胜" : "负"}`);
        res.json({ status: "success", message: `玩家 [${pureName}] 战绩更新成功！` });
    });
});

// 3. 验证管理员 SteamID
app.post('/api/admin/verify', (req, res) => {
    const { steamId } = req.body;
    if (ADMIN_STEAM_IDS.includes(steamId.trim())) {
        res.json({ status: "success", message: "管理员身份验证通过！" });
    } else {
        res.status(403).json({ status: "error", message: "该 SteamID 无管理员权限！" });
    }
});

// 4. 管理员删除玩家
app.delete('/api/admin/player/:playerId', (req, res) => {
    const adminSteamId = req.headers['x-admin-id'];
    if (!adminSteamId || !ADMIN_STEAM_IDS.includes(adminSteamId.trim())) {
        return res.status(403).json({ status: "error", message: "无权执行删除操作！" });
    }

    const targetPlayerId = req.params.playerId;
    db.run("DELETE FROM players WHERE player_id = ?", [targetPlayerId], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        console.log(`👑 [管理员 ${adminSteamId}] 删除了玩家: ${targetPlayerId}`);
        res.json({ status: "success", message: "玩家已被移出排行榜！" });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Crab Game 排行榜服务端运行在: http://localhost:${PORT}`);
});