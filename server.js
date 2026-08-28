const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";

let lastDbUpdateTime = Date.now();

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
            player_id TEXT NOT NULL,
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

app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Admin Control Panel</title><meta charset="utf-8"></head>
        <body style="background:#111; color:#fff; font-family:sans-serif; padding:40px;">
            <h2>🦀 Crab Game 数据库一键同步后台</h2>
            <form action="/api/admin/import-text" method="POST">
                <p>API Secret Key:</p>
                <input type="password" name="apiKey" value="${SERVER_SECRET_KEY}" style="width:300px; padding:8px;"><br><br>
                <p>直接把 <b>leaderboard.txt</b> 文件的全部内容粘贴在下面：</p>
                <textarea name="leaderboardText" style="width:100%; height:300px; background:#222; color:#a3e635; font-family:monospace; padding:10px;"></textarea><br><br>
                <button type="submit" style="background:#9333ea; color:#fff; padding:10px 30px; font-weight:bold; border:none; cursor:pointer;">🚀 立即导入所有玩家数据</button>
            </form>
            <br><hr><br>
            <form action="/api/admin/clear-all-data" method="POST">
                <input type="hidden" name="apiKey" value="${SERVER_SECRET_KEY}">
                <button type="submit" style="background:#ef4444; color:#fff; padding:8px 20px; border:none; cursor:pointer;" onclick="return confirm('确定清空吗？')">⚠️ 清空所有数据</button>
            </form>
        </body>
        </html>
    `);
});

app.post('/api/admin/import-text', async (req, res) => {
    const key = req.body.apiKey;
    if (key !== SERVER_SECRET_KEY) return res.status(403).send("API Key 错误");

    const text = req.body.leaderboardText || "";
    const lines = text.trim().split('\n');
    let count = 0;

    for (let line of lines) {
        if (line.includes('|')) {
            await processRawLine(line);
            count++;
        }
    }

    lastDbUpdateTime = Date.now();
    res.send(`<h1>✅ 导入成功！共处理 ${count} 名玩家！</h1><p><a href='/'>返回前台排行榜</a></p>`);
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

// 🚫 封禁名单查询
app.get('/api/bans', (req, res) => {
    db.all("SELECT player_id, player_name, admin_name, reason, duration, ban_date FROM bans ORDER BY ban_date DESC LIMIT 500", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

app.post('/api/mod/ban-batch', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const bans = Array.isArray(req.body) ? req.body : [req.body];
    const sql = `INSERT INTO bans (player_id, player_name, admin_name, reason, duration, ban_date) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

    for (let b of bans) {
        let steamId = String(b.steamId || "").trim();
        let playerName = String(b.playerName || "Player").trim();
        let adminName = String(b.adminName || "Admin").trim();
        let reason = String(b.reason || "Rules violation").trim();
        let duration = String(b.duration || "Permanent").trim();

        if (/^\d{17}$/.test(steamId)) {
            await new Promise(resolve => {
                db.run(sql, [steamId, playerName, adminName, reason, duration], resolve);
            });
        }
    }

    res.json({ status: "success", count: bans.length });
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

async function processRawLine(line) {
    line = line.trim();
    if (!line.includes('|')) return;

    const parts = line.split('|');
    let steamId = parts[0].trim();
    if (!/^\d{17}$/.test(steamId)) return;

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

        if (k === 'Username' && val) name = val.replace(/<[^>]*>/g, '').trim() || "Player";
        if (k === 'CurrentElo') score = parseInt(val) || 1000;
        if (k === 'PeakElo') peakScore = parseInt(val) || score;
        if (k === 'Wins') wins = parseInt(val) || 0;
        if (k === 'TotalMatches') matches = parseInt(val) || 0;
        if (k === 'BestWinStreak') bestStreak = parseInt(val) || 0;
        if (k === 'CurrentWinStreak') currentStreak = parseInt(val) || 0;
    }

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, 'GLOBAL', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' THEN excluded.name ELSE players.name END,
            score = excluded.score,
            wins = excluded.wins,
            matches = excluded.matches,
            peak_score = MAX(COALESCE(players.peak_score, 1000), excluded.peak_score, excluded.score),
            best_streak = MAX(COALESCE(players.best_streak, 0), excluded.best_streak),
            current_streak = excluded.current_streak,
            updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise(resolve => {
        db.run(sql, [steamId, name, wins, matches, score, peakScore, bestStreak, currentStreak], resolve);
    });
}

app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    if (typeof req.body === 'string' && req.body.includes('|')) {
        const lines = req.body.trim().split('\n');
        for (let line of lines) await processRawLine(line);
        lastDbUpdateTime = Date.now();
        return res.json({ status: "success", count: lines.length });
    }

    if (req.body.rawLine) {
        await processRawLine(req.body.rawLine);
        lastDbUpdateTime = Date.now();
    }

    res.json({ status: "success" });
});

app.all('/api/admin/clear-all-data', (req, res) => {
    const apiKey = req.body?.apiKey || req.query?.key || req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).send("Forbidden: API Key 错误");

    db.run("DELETE FROM players", (err) => {
        if (err) return res.status(500).send("清空失败: " + err.message);
        db.run("DELETE FROM bans", () => {});
        lastDbUpdateTime = Date.now();
        res.send("<h1>✅ 数据库已彻底清空！</h1><p><a href='/admin'>返回后台</a></p>");
    });
});

app.listen(PORT, () => {
    console.log(`[Server] 排行榜服务器已在端口 ${PORT} 启动！`);
});
