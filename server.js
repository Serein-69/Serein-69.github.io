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

// 自动向 Steam 请求国家与名字
async function fetchSteamProfile(steamId) {
    if (!STEAM_API_KEY || STEAM_API_KEY === "YOUR_STEAM_WEB_API_KEY") {
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

// 初始化表结构
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
    console.log("[DB] 数据库已就绪，等待游戏自动上报战绩！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. 排行榜查询接口
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

// 3. 【核心】全自动战绩结算接口（支持单个玩家、整局多个玩家、支持纯文本/JSON自动解析）
async function savePlayerRecord(p) {
    const targetSteamId = String(p.steamId || p.playerId || p.id || "").trim();
    if (!targetSteamId || !/^\d+$/.test(targetSteamId)) return;

    let pureName = cleanName(p.name || p.playerName || p.Username);
    let region = p.region || 'GLOBAL';

    // 如果是新玩家，自动去 Steam 查一次国籍和真实名字
    const steamInfo = await fetchSteamProfile(targetSteamId);
    if (steamInfo) {
        if (region === 'GLOBAL' && steamInfo.countryCode) region = steamInfo.countryCode;
        if (pureName === 'Player' && steamInfo.personaName) pureName = cleanName(steamInfo.personaName);
    }

    const isWin = p.isWin === true || p.isWin === "true" || p.isWin === 1 || p.isWin === "1" || parseInt(p.Wins) > 0;
    const winIncrement = isWin ? 1 : 0;

    // 如果游戏传了明确的最终分数（CurrentElo），直接采用；否则按变动增减分
    if (p.CurrentElo !== undefined || p.currentScore !== undefined || p.score !== undefined) {
        const exactScore = parseInt(p.CurrentElo || p.currentScore || p.score) || 1000;
        const totalMatches = parseInt(p.TotalMatches || p.matches) || 1;
        const totalWins = parseInt(p.Wins || p.wins) || winIncrement;

        const sql = `
            INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Player' THEN excluded.name ELSE players.name END,
                region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
                wins = MAX(players.wins, ?),
                matches = MAX(players.matches, ?),
                score = ?,
                updated_at = CURRENT_TIMESTAMP
        `;
        return new Promise(resolve => db.run(sql, [targetSteamId, pureName, region, totalWins, totalMatches, exactScore, totalWins, totalMatches, exactScore], resolve));
    } else {
        const change = parseInt(p.scoreChange || p.change) || 0;
        const sql = `
            INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
            VALUES (?, ?, ?, ?, 1, MAX(0, 1000 + ?), CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Player' THEN excluded.name ELSE players.name END,
                region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
                wins = players.wins + ?,
                matches = players.matches + 1,
                score = MAX(0, players.score + ?),
                updated_at = CURRENT_TIMESTAMP
        `;
        return new Promise(resolve => db.run(sql, [targetSteamId, pureName, region, winIncrement, change, winIncrement, change], resolve));
    }
}

app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    // 1. 如果传过来的是文本（比如本地格式文本）
    if (typeof req.body === 'string' && req.body.includes('|')) {
        const lines = req.body.trim().split('\n');
        for (let line of lines) {
            const parts = line.trim().split('|');
            const pObj = { steamId: parts[0] };
            for (let i = 1; i < parts.length; i++) {
                const [k, ...v] = parts[i].split(':');
                pObj[k] = v.join(':');
            }
            await savePlayerRecord(pObj);
        }
        return res.json({ status: "success", message: `已自动更新 ${lines.length} 位玩家战绩！` });
    }

    // 2. 如果传过来的是玩家数组
    if (Array.isArray(req.body)) {
        for (const p of req.body) {
            await savePlayerRecord(p);
        }
        return res.json({ status: "success", count: req.body.length });
    }

    // 3. 如果是传单个玩家
    await savePlayerRecord(req.body);
    res.json({ status: "success" });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
