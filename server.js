const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";

process.on('uncaughtException', (err) => console.error('[Anti-Crash]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Anti-Crash]:', reason));

let lastDbUpdateTime = Date.now();

const onlineHeartbeats = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, lastTime] of onlineHeartbeats.entries()) {
        if (now - lastTime > 90000) { 
            onlineHeartbeats.delete(id);
        }
    }
}, 10000);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.use(express.static(__dirname));

let dataFolder = __dirname;
try {
    if (fs.existsSync('/data')) dataFolder = '/data';
} catch (e) {
    dataFolder = __dirname;
}

const dbPath = path.resolve(dataFolder, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (!err) {
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/online', (req, res) => {
    const steamId = String(req.query.id || req.query.steamId || '').trim();
    if (steamId && steamId !== '0') {
        onlineHeartbeats.set(steamId, Date.now());
    }
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(String(Math.max(1, onlineHeartbeats.size)));
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
            let safeName = String(p.name).replace(/\|/g, ' ').replace(/[\r\n]/g, '');
            let line = `${p.player_id}|Username:${safeName}|CurrentElo:${p.score}|PeakElo:${p.peak_score || p.score}|TotalMatches:${p.matches}|Wins:${p.wins}|Losses:${losses}|BestWinStreak:${p.best_streak || 0}|CurrentWinStreak:${p.current_streak || 0}`;
            lines.push(line);
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(lines.join('\n'));
    });
});

app.get('/api/leaderboard', (req, res) => {
    const limit = parseInt(req.query.limit) || 50000;
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

    query += ` ORDER BY score DESC, wins DESC LIMIT ? `;
    params.push(limit);

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
            if (l.startsWith("Admin =")) admin = l.substring(7).trim();
            if (l.startsWith("Player =")) player = l.substring(8).trim();
            if (l.startsWith("Reason =")) reason = l.substring(8).trim();
            if (l.startsWith("Duration =")) duration = l.substring(10).trim();
        }

        let m = player.match(/(\d{17})/);
        if (m) {
            steamId = m[1];
            player = player.replace(steamId, '').replace(/[,\s]+$/g, '').trim() || "Banned Player";
        }

        if (/^\d{17}$/.test(steamId)) {
            await new Promise((resolve) => {
                db.run(sql, [steamId, player, admin, reason, duration], resolve);
            });
            successCount++;
        }
    }

    res.json({ status: "success", count: successCount });
});

app.get('/api/player/:steamId/rank', (req, res) => {
    const steamId = String(req.params.steamId || '').trim();
    if (!steamId) return res.status(400).json({ status: "error", message: "Missing SteamID" });

    const sql = `
        WITH RankedPlayers AS (
            SELECT 
                player_id, score, wins, matches, peak_score, best_streak,
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

app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    let lines = [];
    if (typeof req.body === 'string' && req.body.includes('|')) {
        lines = req.body.trim().split('\n');
    } else if (req.body.rawLine) {
        lines = [req.body.rawLine];
    } else if (req.body.steamId && req.body.score !== undefined) {
        let pId = String(req.body.steamId);
        let pName = String(req.body.name || "Player").trim();
        let pScore = parseInt(req.body.score) || 1000;
        let pWins = parseInt(req.body.wins) || 0;
        let pMatches = parseInt(req.body.matches) || 0;

        const sql = `
            INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
            VALUES (?, ?, 'GLOBAL', ?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Player' AND excluded.name != '' THEN excluded.name ELSE players.name END,
                score = excluded.score,
                wins = excluded.wins,
                matches = excluded.matches,
                peak_score = MAX(COALESCE(players.peak_score, 1000), excluded.score, players.score),
                updated_at = CURRENT_TIMESTAMP
        `;

        await new Promise((resolve) => db.run(sql, [pId, pName, pWins, pMatches, pScore, pScore], resolve));
        lastDbUpdateTime = Date.now();
        return res.json({ status: "success" });
    }

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, 'GLOBAL', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != '' THEN excluded.name ELSE players.name END,
            score = excluded.score,
            wins = excluded.wins,
            matches = excluded.matches,
            peak_score = MAX(COALESCE(players.peak_score, 1000), excluded.score, players.score),
            best_streak = MAX(COALESCE(players.best_streak, 0), excluded.best_streak),
            current_streak = excluded.current_streak,
            updated_at = CURRENT_TIMESTAMP
    `;

    for (let line of lines) {
        line = line.trim();
        if (!line.includes('|')) continue;

        const parts = line.split('|');
        let steamId = parts[0].trim();
        if (!/^\d{17}$/.test(steamId)) continue;

        let name = "Player";
        let score = 1000;
        let peakScore = 1000;
        let wins = 0;
        let matches = 0;
        let bestStreak = 0;
        let currentStreak = 0;

        for (let part of parts.slice(1)) {
            let [k, ...v] = part.split(':');
            let val = v.join(':').trim();

            if (k === 'Username' && val) name = val;
            if (k === 'CurrentElo') score = parseInt(val) || 1000;
            if (k === 'PeakElo') peakScore = parseInt(val) || score;
            if (k === 'Wins') wins = parseInt(val) || 0;
            if (k === 'TotalMatches') matches = parseInt(val) || 0;
            if (k === 'BestWinStreak') bestStreak = parseInt(val) || 0;
            if (k === 'CurrentWinStreak') currentStreak = parseInt(val) || 0;
        }

        await new Promise((resolve) => {
            db.run(sql, [steamId, name, wins, matches, score, peakScore, bestStreak, currentStreak], resolve);
        });
    }

    lastDbUpdateTime = Date.now();
    res.json({ status: "success" });
});

app.post('/api/mod/bind', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const cleanSteamId = String(req.body.steamId || "").trim();
    let manualRegion = (req.body.region || "").trim().toUpperCase();
    let playerName = String(req.body.name || "Player").trim();

    if (!/^\d{17}$/.test(cleanSteamId)) return res.status(400).json({ status: "error" });

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, ?, 0, 0, 1000, 1000, 0, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' THEN excluded.name ELSE players.name END,
            region = excluded.region,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [cleanSteamId, playerName, manualRegion], function (err) {
        if (err) return res.status(500).json({ status: "error" });
        lastDbUpdateTime = Date.now();
        res.json({ status: "success", region: manualRegion });
    });
});

app.all('/api/admin/clear-all-data', (req, res) => {
    const apiKey = req.body?.apiKey || req.query?.key || req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden: API Key 错误");

    db.run("DELETE FROM players", (err) => {
        if (err) return res.status(500).send("清空失败: " + err.message);
        db.run("DELETE FROM bans", () => {});
        lastDbUpdateTime = Date.now();
        res.send("<h1>✅ 数据库与封禁名单已彻底清空！</h1><p><a href='/'>返回前台</a></p>");
    });
});

app.listen(PORT, () => {
    console.log(`[Server] 服务已成功启动在端口 ${PORT}！`);
});
