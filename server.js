const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";

// 🛡️ 全局防崩溃守护
process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] 未捕获异常 (已拦截，服务继续运行):', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash] 未处理的异步拒绝 (已拦截):', reason);
});

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
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
    }
});

db.serialize(() => {
    try {
        // 玩家排行榜表
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

        // 🚫 封禁表
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

        // 尝试安全添加字段（忽略重复添加报错）
        db.run(`ALTER TABLE players ADD COLUMN peak_score INTEGER DEFAULT 1000;`, () => {});
        db.run(`ALTER TABLE players ADD COLUMN best_streak INTEGER DEFAULT 0;`, () => {});
        db.run(`ALTER TABLE players ADD COLUMN current_streak INTEGER DEFAULT 0;`, () => {});

        db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`, () => {});
        db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`, () => {});
        console.log("[DB] 数据库已完全就绪！");
    } catch (e) {
        console.error("[DB Init Warning]:", e.message);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 版本检测
app.get('/api/leaderboard/version', (req, res) => {
    res.json({ status: "success", version: lastDbUpdateTime });
});

// 导出全量数据
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

// 🚫 封禁名单查询
app.get('/api/bans', (req, res) => {
    db.all("SELECT player_id, player_name, admin_name, reason, duration, ban_date FROM bans ORDER BY ban_date DESC LIMIT 500", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

// 🚫 接收批量 banlogs 上报
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
            await new Promise(resolve => {
                db.run(sql, [steamId, player, admin, reason, duration], resolve);
            });
            successCount++;
        }
    }

    res.json({ status: "success", count: successCount });
});

// 🏆 单玩家全网总排名计算
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

// 🎯 接收比赛结算数据
app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    let lines = [];
    if (typeof req.body === 'string' && req.body.includes('|')) {
        lines = req.body.trim().split('\n');
    } else if (req.body.rawLine) {
        lines = [req.body.rawLine];
    }

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, peak_score, best_streak, current_streak, updated_at)
        VALUES (?, ?, 'GLOBAL', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            score = excluded.score,
            wins = excluded.wins,
            matches = excluded.matches,
            peak_score = MAX(COALESCE(players.peak_score, 1000), excluded.peak_score, excluded.score, players.score),
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

            if (k === 'Username' && val) name = val.replace(/<[^>]*>/g, '').trim() || "Player";
            if (k === 'CurrentElo') score = parseInt(val) || 1000;
            if (k === 'PeakElo') peakScore = parseInt(val) || score;
            if (k === 'Wins') wins = parseInt(val) || 0;
            if (k === 'TotalMatches') matches = parseInt(val) || 0;
            if (k === 'BestWinStreak') bestStreak = parseInt(val) || 0;
            if (k === 'CurrentWinStreak') currentStreak = parseInt(val) || 0;
        }

        await new Promise(resolve => {
            db.run(sql, [steamId, name, wins, matches, score, peakScore, bestStreak, currentStreak], resolve);
        });
    }

    lastDbUpdateTime = Date.now();
    res.json({ status: "success" });
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
