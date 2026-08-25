const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";
const STEAM_API_KEY = process.env.STEAM_API_KEY || "4DD351A754D7C9273E2A6EC640D845B1";

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
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

async function fetchSteamProfile(steamId) {
    if (!STEAM_API_KEY) return null;
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

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'GLOBAL',
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            peak_score INTEGER DEFAULT 1000,
            best_streak INTEGER DEFAULT 0,
            current_streak INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 自动平滑升级已有数据库表结构
    db.run(`ALTER TABLE players ADD COLUMN peak_score INTEGER DEFAULT 1000;`, () => {});
    db.run(`ALTER TABLE players ADD COLUMN best_streak INTEGER DEFAULT 0;`, () => {});
    db.run(`ALTER TABLE players ADD COLUMN current_streak INTEGER DEFAULT 0;`, () => {});

    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);
    console.log("[DB] 数据库已就绪（支持全网排名计算与防低分覆盖）！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 排行榜列表查询接口
app.get('/api/leaderboard', (req, res) => {
    const regionFilter = (req.query.region || '').trim().toUpperCase();
    let query = `
        SELECT player_id, name, region, wins, matches, score,
               COALESCE(peak_score, score) as peak_score,
               COALESCE(best_streak, 0) as best_streak,
               COALESCE(current_streak, 0) as current_streak,
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

// 🔍 单玩家基础数据查询接口
app.get('/api/player/:steamId', (req, res) => {
    const steamId = String(req.params.steamId || '').trim();
    if (!steamId) return res.status(400).json({ status: "error", message: "Missing SteamID" });

    db.get(
        "SELECT player_id, name, region, wins, matches, score, COALESCE(peak_score, score) as peak_score, COALESCE(best_streak, 0) as best_streak FROM players WHERE player_id = ?",
        [steamId],
        (err, row) => {
            if (err || !row) return res.status(404).json({ status: "not_found" });
            res.json({ status: "success", data: row });
        }
    );
});

// 🏆【新增】：精准获取玩家在全网的总名次（Rank #N）
app.get('/api/player/:steamId/rank', (req, res) => {
    const steamId = String(req.params.steamId || '').trim();
    if (!steamId) return res.status(400).json({ status: "error", message: "Missing SteamID" });

    // 先查出该玩家的当前分
    db.get("SELECT score, wins, matches, peak_score, best_streak FROM players WHERE player_id = ?", [steamId], (err, player) => {
        if (err || !player) return res.status(404).json({ status: "not_found" });

        // 计算全网有多少人的 score 比他高（排名 = 比他分高的人数 + 1）
        db.get(
            "SELECT COUNT(*) as rank_count FROM players WHERE score > ? OR (score = ? AND wins > ?)", 
            [player.score, player.score, player.wins], 
            (err, rankResult) => {
                if (err) return res.status(500).json({ status: "error", message: err.message });
                const globalRank = (rankResult?.rank_count || 0) + 1;
                res.json({
                    status: "success",
                    data: {
                        rank: globalRank,
                        score: player.score,
                        peakScore: player.peak_score || player.score,
                        wins: player.wins,
                        matches: player.matches,
                        bestStreak: player.best_streak || 0
                    }
                });
            }
        );
    });
});

// 手动绑定国籍接口
app.post('/api/mod/bind', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const cleanSteamId = String(req.body.steamId || "").trim();
    let manualRegion = (req.body.region || "").trim().toUpperCase();
    let playerName = cleanName(req.body.name);

    if (!cleanSteamId || !/^\d{17}$/.test(cleanSteamId)) {
        return res.status(400).json({ status: "error", message: "SteamID 无效" });
    }

    if (!manualRegion || manualRegion === 'GLOBAL') {
        const steamInfo = await fetchSteamProfile(cleanSteamId);
        manualRegion = steamInfo?.countryCode || 'GLOBAL';
        if (playerName === 'Player' && steamInfo?.personaName) {
            playerName = cleanName(steamInfo.personaName);
        }
    }

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, ?, 0, 0, 1000, 1000, 0, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            region = excluded.region,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [cleanSteamId, playerName, manualRegion], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", region: manualRegion });
    });
});

// 核心多服务器数据合并处理（防低版本/低胜场覆盖）
async function processReport(body) {
    let steamId = String(body.steamId || body.playerId || "").trim();
    let name = cleanName(body.name || body.playerName);
    let score = null;
    let peakScore = null;
    let wins = null;
    let matches = null;
    let bestStreak = 0;
    let currentStreak = 0;

    if (body.rawLine && typeof body.rawLine === 'string') {
        const parts = body.rawLine.split('|');
        if (parts.length > 0 && /^\d+$/.test(parts[0])) steamId = parts[0];
        for (let i = 1; i < parts.length; i++) {
            const [k, ...v] = parts[i].split(':');
            const val = v.join(':');
            if (k === 'Username' && (!name || name === 'Player')) name = cleanName(val);
            if (k === 'CurrentElo' || k === 'Elo') score = parseInt(val);
            if (k === 'PeakElo') peakScore = parseInt(val);
            if (k === 'Wins') wins = parseInt(val);
            if (k === 'TotalMatches' || k === 'GamesPlayed') matches = parseInt(val);
            if (k === 'BestWinStreak') bestStreak = parseInt(val) || 0;
            if (k === 'CurrentWinStreak') currentStreak = parseInt(val) || 0;
        }
    }

    if (!steamId || !/^\d+$/.test(steamId)) return;

    let region = 'GLOBAL';
    const steamInfo = await fetchSteamProfile(steamId);
    if (steamInfo) {
        if (steamInfo.countryCode) region = steamInfo.countryCode;
        if ((!name || name === 'Player' || name === 'Unknown') && steamInfo.personaName) {
            name = cleanName(steamInfo.personaName);
        }
    }

    if (score === null) score = Math.max(0, 1000 + (parseInt(body.scoreChange) || 0));
    if (peakScore === null) peakScore = score;
    else peakScore = Math.max(peakScore, score);

    if (wins === null) wins = body.isWin ? 1 : 0;
    if (matches === null) matches = 1;

    // 🔥 智能多服合并：胜场只增不减，当前分取最新/更高数据，历史最高分取峰值
    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
            
            -- 当前分：若上传数据场次更多或分数更高，才采纳新的当前分
            score = CASE 
                WHEN excluded.matches >= players.matches THEN excluded.score 
                WHEN excluded.score > players.score THEN excluded.score
                ELSE players.score 
            END,

            -- 胜场和总场次：坚决取最大值
            wins = MAX(players.wins, excluded.wins),
            matches = MAX(players.matches, excluded.matches),

            -- 历史最高分和最高连胜：始终保留最大峰值
            peak_score = MAX(COALESCE(players.peak_score, 1000), excluded.peak_score, excluded.score, players.score),
            best_streak = MAX(COALESCE(players.best_streak, 0), excluded.best_streak),
            current_streak = excluded.current_streak,
            updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise(resolve => {
        db.run(sql, [steamId, name, region, wins, matches, score, peakScore, bestStreak, currentStreak], resolve);
    });
}

app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    if (typeof req.body === 'string' && req.body.includes('|')) {
        const lines = req.body.trim().split('\n');
        for (let line of lines) {
            const parts = line.split('|');
            const pObj = { steamId: parts[0], rawLine: line };
            await processReport(pObj);
        }
        return res.json({ status: "success", count: lines.length });
    }

    if (Array.isArray(req.body)) {
        for (const item of req.body) await processReport(item);
    } else {
        await processReport(req.body);
    }

    res.json({ status: "success" });
});

app.all('/api/admin/clear-all-data', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey || req.query.key;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden: API Key 错误");

    db.run("DELETE FROM players", (err) => {
        if (err) return res.status(500).send("清空失败: " + err.message);
        res.send("<h1>✅ 数据库已彻底清空！</h1><p><a href='/'>返回排行榜</a></p>");
    });
});

app.listen(PORT, () => {
    console.log(`[Server] 排行榜服务器已在端口 ${PORT} 启动！`);
});
