const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Unknown";
    return String(name)
        .replace(/<color=[^>]*>/gi, '')
        .replace(/<\/color>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[[0-9a-fA-F]{6}\]/g, '')
        .replace(/\[\^[0-9]\]/g, '')
        .replace(/<#[\da-fA-F]+>/g, '')
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
        .replace(/^["']|["']$/g, '')
        .trim() || "Unknown";
}

let dataFolder = __dirname;
try {
    if (fs.existsSync('/data')) {
        dataFolder = '/data';
    }
} catch (e) {
    dataFolder = __dirname;
}

const dbPath = path.resolve(dataFolder, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database error:", err.message);
    else {
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
        db.run("PRAGMA cache_size = -64000;");
    }
});

// 初始化数据库表
db.serialize(() => {
    // 玩家表
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'Global',
            bind_key TEXT,
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 密钥池表（存放给 Discord 机器人发放的密钥和对应国籍）
    db.run(`
        CREATE TABLE IF NOT EXISTS access_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_code TEXT UNIQUE,
            region TEXT DEFAULT 'CN',
            bound_steam_id TEXT,
            discord_id TEXT,
            status TEXT DEFAULT 'unassigned',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            bound_at DATETIME
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_region ON players(region);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);

    console.log("[DB] 数据库服务就绪！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. 排行榜列表查询接口
app.get('/api/leaderboard', (req, res) => {
    const regionFilter = req.query.region || 'Global';
    let query = `
        SELECT player_id, name, region, wins, matches, score,
               ROUND((CAST(wins AS FLOAT) / CAST(CASE WHEN matches = 0 THEN 1 ELSE matches END AS FLOAT)) * 100, 1) as winRate
        FROM players 
    `;
    const params = [];

    if (regionFilter !== 'Global' && regionFilter !== 'ALL') {
        query += ` WHERE region = ? `;
        params.push(regionFilter.toUpperCase());
    }

    query += ` ORDER BY score DESC, wins DESC LIMIT 50000 `;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", region: regionFilter, data: rows || [] });
    });
});

// 2. Discord 机器人生成/发放密钥接口 (供 Discord Bot 调用)
// 机器人调用时传: { discordId: "123456", region: "CN" }
app.post('/api/bot/generate-key', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const discordId = req.body.discordId || "unknown";
    const region = (req.body.region || "CN").toUpperCase();
    
    // 生成一个标准的随机 GUID 密钥
    const generatedKey = 'CRAB-' + Math.random().toString(36).substr(2, 6).toUpperCase() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    const sql = `INSERT INTO access_keys (key_code, region, discord_id, status) VALUES (?, ?, ?, 'pending')`;
    db.run(sql, [generatedKey, region, discordId], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({
            status: "success",
            keyCode: generatedKey,
            region: region,
            message: `成功为 Discord 用户生成密钥！`
        });
    });
});

// 3. 游戏内玩家输入 !bind <密钥> 绑定 SteamID 与国籍
app.post('/api/bind', (req, res) => {
    const { steamId, keyCode } = req.body;
    if (!steamId || !keyCode) {
        return res.status(400).json({ status: "error", message: "缺少 SteamID 或密钥" });
    }

    const cleanKey = keyCode.trim();
    const cleanSteamId = String(steamId).trim();

    db.get("SELECT * FROM access_keys WHERE key_code = ?", [cleanKey], (err, keyRecord) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        if (!keyRecord) {
            return res.status(404).json({ status: "error", message: "密钥无效！" });
        }
        if (keyRecord.status === 'bound' && keyRecord.bound_steam_id !== cleanSteamId) {
            return res.status(400).json({ status: "error", message: "该密钥已被其他账号绑定！" });
        }

        const assignedRegion = keyRecord.region || 'CN';

        // 标记密钥为已绑定，并同步更新玩家表中的国籍与密钥
        db.run("UPDATE access_keys SET bound_steam_id = ?, status = 'bound', bound_at = CURRENT_TIMESTAMP WHERE key_code = ?", [cleanSteamId, cleanKey], () => {
            db.run(`
                INSERT INTO players (player_id, name, region, bind_key, wins, matches, score, updated_at)
                VALUES (?, 'Player', ?, ?, 0, 0, 1000, CURRENT_TIMESTAMP)
                ON CONFLICT(player_id) DO UPDATE SET
                    region = excluded.region,
                    bind_key = excluded.bind_key,
                    updated_at = CURRENT_TIMESTAMP
            `, [cleanSteamId, assignedRegion, cleanKey], () => {
                res.json({ status: "success", message: `绑定成功！已加入 [${assignedRegion}] 地区天梯。` });
            });
        });
    });
});

// 4. 比赛结算自动上传（完全自动，无需玩家任何手动操作）
app.post('/api/score', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "Forbidden" });
    }

    const targetSteamId = String(req.body.steamId || req.body.playerId || "").trim();
    const pureName = cleanName(req.body.name || req.body.playerName);
    const isWin = req.body.isWin === true || req.body.isWin === "true" || req.body.isWin === 1 || req.body.isWin === "1";
    const change = parseInt(req.body.scoreChange || req.body.change || req.body.score) || 0;
    const winIncrement = isWin ? 1 : 0;

    if (!targetSteamId || !/^\d+$/.test(targetSteamId)) {
        return res.status(400).json({ status: "error", message: "Missing SteamID" });
    }

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, 'CN', ?, 1, MAX(0, 1000 + ?), CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Unknown' AND excluded.name != '' THEN excluded.name ELSE players.name END,
            wins = players.wins + ?,
            matches = players.matches + 1,
            score = MAX(0, players.score + ?),
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [targetSteamId, pureName, winIncrement, change, winIncrement, change], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });

        db.get("SELECT player_id, name, region, score, wins, matches FROM players WHERE player_id = ?", [targetSteamId], (err, row) => {
            console.log(`[战绩全自动同步] ID: ${targetSteamId} | 玩家: ${row.name} | 分数: ${row.score}`);
            res.json({ status: "success", data: row });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
