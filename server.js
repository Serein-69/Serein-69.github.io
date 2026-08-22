const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";
const STEAM_API_KEY = process.env.STEAM_API_KEY || "YOUR_STEAM_WEB_API_KEY";

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Player";
    return String(name)
        .replace(/<color=[^>]*>/gi, '')
        .replace(/<\/color>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[[0-9a-fA-F]{6}\]/g, '')
        .replace(/\[\^[0-9]\]/g, '')
        .replace(/<#[\da-fA-F]+>/g, '')
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
        .replace(/^["']|["']$/g, '')
        .trim() || "Player";
}

// 自动向 Steam API 抓取公开的国籍和 Steam 真实名字
async function fetchSteamProfile(steamId) {
    if (!STEAM_API_KEY || STEAM_API_KEY === "YOUR_STEAM_WEB_API_KEY") return null;
    try {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const res = await fetch(url);
        const data = await res.json();
        const player = data?.response?.players?.[0];
        if (!player) return null;

        return {
            personaName: player.personaname || null,
            countryCode: player.loccountrycode ? player.loccountrycode.toUpperCase() : 'GLOBAL'
        };
    } catch (e) {
        return null;
    }
}

let dataFolder = __dirname;
try {
    if (fs.existsSync('/data')) dataFolder = '/data';
} catch (e) {
    dataFolder = __dirname;
}

const dbPath = path.resolve(dataFolder, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database error:", err.message);
    else {
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
    }
});

// 初始化数据库表
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'GLOBAL',
            discord_id TEXT,
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);
    console.log("[DB] 数据库服务就绪，完全适配 C# 插件！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. 排行榜列表接口
app.get('/api/leaderboard', (req, res) => {
    const regionFilter = (req.query.region || '').trim().toUpperCase();
    let query = `
        SELECT player_id, name, region, wins, matches, score,
               ROUND((CAST(wins AS FLOAT) / CAST(CASE WHEN matches = 0 THEN 1 ELSE matches END AS FLOAT)) * 100, 1) as winRate
        FROM players 
    `;
    const params = [];

    if (regionFilter && regionFilter !== 'GLOBAL' && regionFilter !== 'ALL') {
        query += ` WHERE region = ? `;
        params.push(regionFilter);
    }

    query += ` ORDER BY score DESC, wins DESC LIMIT 50000 `;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

// 2. Discord 机器人绑定接口
app.post('/api/bot/bind-steam', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const cleanSteamId = String(req.body.steamId || "").trim();
    if (!cleanSteamId || !/^\d{17}$/.test(cleanSteamId)) {
        return res.status(400).json({ status: "error", message: "SteamID 格式不正确" });
    }

    const steamInfo = await fetchSteamProfile(cleanSteamId);
    const country = steamInfo?.countryCode || 'GLOBAL';
    const steamName = cleanName(steamInfo?.personaName || 'Player');

    const sql = `
        INSERT INTO players (player_id, name, region, discord_id, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, 1000, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            region = excluded.region,
            discord_id = excluded.discord_id,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [cleanSteamId, steamName, country, req.body.discordId || null], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({
            status: "success",
            data: { steamId: cleanSteamId, name: steamName, region: country }
        });
    });
});

// 3. 【核心修复】深度解析 C# 插件传来的整行 rawLine 与战绩
async function processReport(body) {
    let steamId = String(body.steamId || body.playerId || "").trim();
    let name = cleanName(body.name || body.playerName);
    let score = null;
    let wins = null;
    let matches = null;

    // 解析插件传来的 rawLine 管道符文本（例如: 76561199001480321|Username:site|CurrentElo:1025|TotalMatches:1|Wins:1）
    if (body.rawLine && typeof body.rawLine === 'string') {
        const parts = body.rawLine.split('|');
        if (parts.length > 0 && /^\d+$/.test(parts[0])) {
            steamId = parts[0];
        }
        for (let i = 1; i < parts.length; i++) {
            const [k, ...v] = parts[i].split(':');
            const val = v.join(':');
            if (k === 'Username' && (!name || name === 'Player')) name = cleanName(val);
            if (k === 'CurrentElo') score = parseInt(val);
            if (k === 'Wins') wins = parseInt(val);
            if (k === 'TotalMatches') matches = parseInt(val);
        }
    }

    if (!steamId || !/^\d+$/.test(steamId)) return;

    // 自动查询 Steam 国籍
    let region = 'GLOBAL';
    const steamInfo = await fetchSteamProfile(steamId);
    if (steamInfo) {
        if (steamInfo.countryCode) region = steamInfo.countryCode;
        if ((!name || name === 'Player' || name === 'Unknown') && steamInfo.personaName) {
            name = cleanName(steamInfo.personaName);
        }
    }

    // 默认 fallback
    if (score === null) {
        const change = parseInt(body.scoreChange) || 0;
        score = Math.max(0, 1000 + change);
    }
    if (wins === null) wins = body.isWin ? 1 : 0;
    if (matches === null) matches = 1;

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
            wins = ?,
            matches = ?,
            score = ?,
            updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise(resolve => {
        db.run(sql, [steamId, name, region, wins, matches, score, wins, matches, score], function (err) {
            if (!err) {
                console.log(`[插件全自动同步] ID: ${steamId} | 玩家: ${name} | 分数: ${score} | 胜场: ${wins}/${matches} | 国家: ${region}`);
            }
            resolve();
        });
    });
}

// 接收 C# 插件的 POST
app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    // 兼容数组/单条
    if (Array.isArray(req.body)) {
        for (const item of req.body) {
            await processReport(item);
        }
    } else {
        await processReport(req.body);
    }

    res.json({ status: "success" });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
