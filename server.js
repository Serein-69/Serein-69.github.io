const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";
// 你的 Steam Web API Key (可在 https://steamcommunity.com/dev/apikey 获取)
const STEAM_API_KEY = process.env.STEAM_API_KEY || "YOUR_STEAM_WEB_API_KEY";

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

// 辅助函数：根据 SteamID 请求 Steam API 查询玩家国家和昵称
async function fetchSteamProfile(steamId) {
    if (!STEAM_API_KEY || STEAM_API_KEY === "YOUR_STEAM_WEB_API_KEY") {
        console.warn("[Steam API] 未配置 STEAM_API_KEY，跳过在线查询。");
        return null;
    }
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
        console.error("[Steam API Error]", e.message);
        return null;
    }
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
            discord_id TEXT,
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// 2. Discord Bot 专属绑定接口：自动通过 Steam API 获取国家与昵称
app.post('/api/bot/bind-steam', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "Forbidden" });
    }

    const { steamId, discordId } = req.body;
    const cleanSteamId = String(steamId || "").trim();

    if (!cleanSteamId || !/^\d{17}$/.test(cleanSteamId)) {
        return res.status(400).json({ status: "error", message: "无效的 64 位 SteamID！" });
    }

    // 自动请求 Steam 官方 API 查询玩家个人资料中的国家和名字
    const steamInfo = await fetchSteamProfile(cleanSteamId);
    const country = steamInfo?.countryCode || 'GLOBAL';
    const steamName = cleanName(steamInfo?.personaName || 'Player');

    const sql = `
        INSERT INTO players (player_id, name, region, discord_id, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, 1000, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Unknown' AND excluded.name != 'Player' THEN excluded.name ELSE players.name END,
            region = excluded.region,
            discord_id = excluded.discord_id,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [cleanSteamId, steamName, country, discordId || null], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({
            status: "success",
            data: {
                steamId: cleanSteamId,
                name: steamName,
                region: country,
                discordId: discordId
            },
            message: `绑定成功！玩家: ${steamName} | 国家: ${country}`
        });
    });
});

// 3. 游戏内比赛结算上报接口
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
        VALUES (?, ?, 'GLOBAL', ?, 1, MAX(0, 1000 + ?), CURRENT_TIMESTAMP)
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
            console.log(`[战绩同步] ID: ${targetSteamId} | 玩家: ${row?.name} | 地区: ${row?.region} | 分数: ${row?.score}`);
            res.json({ status: "success", data: row });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
