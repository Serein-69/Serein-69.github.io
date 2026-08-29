const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";
const STEAM_API_KEY = process.env.STEAM_API_KEY || "4DD351A754D7C9273E2A6EC640D845B1";

// 🛡️ 全局防崩溃拦截
process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] 未捕获异常 (已拦截):', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash] 未处理拒绝 (已拦截):', reason);
});

let lastDbUpdateTime = Date.now();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Player";
    let str = String(name)
        .replace(/<[^>]*>/g, '')              
        .replace(/\[[0-9a-fA-F]{6}\]/g, '')   
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') 
        .trim();
    return str || "Player";
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

    db.run(`
        CREATE TABLE IF NOT EXISTS bans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            player_name TEXT NOT NULL,
            admin_name TEXT DEFAULT 'Admin',
            reason TEXT DEFAULT 'Violation of rules',
            duration TEXT DEFAULT 'Permanent',
            ban_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`ALTER TABLE players ADD COLUMN peak_score INTEGER DEFAULT 1000;`, () => {});
    db.run(`ALTER TABLE players ADD COLUMN best_streak INTEGER DEFAULT 0;`, () => {});
    db.run(`ALTER TABLE players ADD COLUMN current_streak INTEGER DEFAULT 0;`, () => {});

    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);
    console.log("[DB] 数据库已就绪（支持排行榜与 banlogs 封禁黑名单）！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/leaderboard/version', (req, res) => {
    res.json({ status: "success", version: lastDbUpdateTime });
});

app.get('/api/leaderboard/export', (req, res) => {
    db.all("SELECT player_id, name, score, peak_score, wins, matches, best_streak, current_streak FROM players ORDER BY score DESC, wins DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        
        let lines = [];
        for (let p of (rows || [])) {
            let losses = Math.max(0, p.matches - p.wins);
            let safeName = String(p.name).replace(/\|/g, ' ');
            let line = `${p.player_id}|Username:${safeName}|CurrentElo:${p.score}|PeakElo:${p.peak_score || p.score}|TotalMatches:${p.matches}|Wins:${p.wins}|Losses:${losses}|BestWinStreak:${p.best_streak || 0}|CurrentWinStreak:${p.current_streak || 0}`;
            lines.push(line);
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(lines.join('\n'));
    });
});

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

app.get('/api/bans', (req, res) => {
    db.all("SELECT player_id, player_name, admin_name, reason, duration, ban_date FROM bans ORDER BY ban_date DESC LIMIT 500", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

app.post('/api/mod/ban-batch', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const rawContent = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!rawContent || !rawContent.trim()) return res.json({ status: "success", count: 0 });

    const logBlocks = rawContent.split(/===BAN_LOG_SPLIT===/g);
    let successCount = 0;

    const sql = `
        INSERT INTO bans (player_id, player_name, admin_name, reason, duration, ban_date)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    for (let block of logBlocks) {
        if (!block.trim()) continue;

        let admin = "Admin";
        let player = "Player";
        let reason = "Violation of server rules";
        let duration = "Permanent";
        let steamId = "";

        const lines = block.trim().split('\n');
        for (let line of lines) {
            let l = line.trim();
            if (l.startsWith("Admin =")) admin = cleanName(l.substring(7));
            if (l.startsWith("Player =")) player = cleanName(l.substring(8));
            if (l.startsWith("Reason =")) reason = l.substring(8).trim();
            if (l.startsWith("Duration =")) duration = l.substring(10).trim();
        }

        let m = player.match(/(\d{17})/);
        if (m) {
            steamId = m[1];
            player = player.replace(steamId, '').replace(/[,\s]+$/g, '').trim() || "Banned Player";
        }

        if (/^\d{17}$/.test(steamId)) {
            await new Promise(resolve => {
                db.run(sql, [steamId, player, admin, reason, duration], resolve);
            });
            successCount++;
        }
    }

    res.json({ status: "success", count: successCount });
});

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

app.get('/api/player/:steamId/rank', (req, res) => {
    const steamId = String(req.params.steamId || '').trim();
    if (!steamId) return res.status(400).json({ status: "error", message: "Missing SteamID" });

    const sql = `
        WITH RankedPlayers AS (
            SELECT 
                player_id, 
                score, 
                wins, 
                matches, 
                peak_score, 
                best_streak,
                ROW_NUMBER() OVER (ORDER BY score DESC, wins DESC, id ASC) as global_rank
            FROM players
        )
        SELECT * FROM RankedPlayers WHERE player_id = ?
    `;

    db.get(sql, [steamId], (err, row) => {
        if (err || !row) return res.status(404).json({ status: "not_found" });
        
        res.json({
            status: "success",
            data: {
                rank: row.global_rank,
                score: row.score,
                peakScore: row.peak_score || row.score,
                wins: row.wins,
                matches: row.matches,
                bestStreak: row.best_streak || 0
            }
        });
    });
});

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
        lastDbUpdateTime = Date.now();
        res.json({ status: "success", region: manualRegion });
    });
});

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
        const line = body.rawLine.trim();
        const firstPipe = line.indexOf('|');
        if (firstPipe > 0) {
            const possibleId = line.substring(0, firstPipe).trim();
            if (/^\d{17}$/.test(possibleId)) steamId = possibleId;
        }

        const extractField = (key) => {
            const reg = new RegExp(`(?:\\||^)${key}:(.*?)(?=\\|[A-Za-z]+:|$)`);
            const m = line.match(reg);
            return m ? m[1].trim() : null;
        };

        const uName = extractField('Username');
        if (uName && (!name || name === 'Player')) name = cleanName(uName);

        const eloVal = extractField('CurrentElo') || extractField('Elo');
        if (eloVal) score = parseInt(eloVal);

        const peakVal = extractField('PeakElo');
        if (peakVal) peakScore = parseInt(peakVal);

        const winsVal = extractField('Wins');
        if (winsVal) wins = parseInt(winsVal);

        const matchesVal = extractField('TotalMatches') || extractField('GamesPlayed');
        if (matchesVal) matches = parseInt(matchesVal);

        const bestStrVal = extractField('BestWinStreak');
        if (bestStrVal) bestStreak = parseInt(bestStrVal) || 0;

        const curStrVal = extractField('CurrentWinStreak');
        if (curStrVal) currentStreak = parseInt(curStrVal) || 0;
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

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
            score = excluded.score,
            wins = excluded.wins,
            matches = excluded.matches,
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
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    if (typeof req.body === 'string' && req.body.includes('|')) {
        const lines = req.body.trim().split('\n');
        for (let line of lines) {
            const parts = line.split('|');
            const pObj = { steamId: parts[0], rawLine: line };
            await processReport(pObj);
        }
        lastDbUpdateTime = Date.now();
        return res.json({ status: "success", count: lines.length });
    }

    if (Array.isArray(req.body)) {
        for (const item of req.body) await processReport(item);
    } else {
        await processReport(req.body);
    }

    lastDbUpdateTime = Date.now();
    res.json({ status: "success" });
});

app.all('/api/admin/clear-all-data', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey || req.query.key;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden: API Key 错误");

    db.run("DELETE FROM players", (err) => {
        if (err) return res.status(500).send("清空失败: " + err.message);
        db.run("DELETE FROM bans", () => {});
        lastDbUpdateTime = Date.now();
        res.send("<h1>✅ 数据库已彻底清空！</h1><p><a href='/'>返回排行榜</a></p>");
    });
});

app.listen(PORT, () => {
    console.log(`[Server] 排行榜与封禁服务器已在端口 ${PORT} 启动！`);
});
