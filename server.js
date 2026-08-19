const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const initialPlayers = require('./playersData');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Unknown";
    return String(name).replace(/<[^>]*>/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() || "Unknown";
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

// 初始化数据库、自动迁移与清洗旧假数据
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'Global',
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);

    // 核心修复 1：清除所有非纯数字的遗留假 ID 数据（例如 legacy_xx）
    db.run(`DELETE FROM players WHERE player_id NOT GLOB '[0-9]*'`);

    // 核心修复 2：将 CSV 中真实的 SteamID 玩家导入，如果已存在 SteamID 则保留真实分数不覆盖
    db.run("BEGIN TRANSACTION;");
    const stmt = db.prepare(`
        INSERT INTO players (player_id, name, region, wins, matches, score)
        VALUES (?, ?, 'Global', ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE players.name END
    `);

    if (Array.isArray(initialPlayers)) {
        initialPlayers.forEach(p => {
            if (p && p.id && /^\d+$/.test(String(p.id).trim())) {
                const sid = String(p.id).trim();
                stmt.run(sid, cleanName(p.name), p.wins || 0, p.matches || 0, p.score || 1000);
            }
        });
    }
    stmt.finalize();
    db.run("COMMIT;", () => {
        console.log("[DB] Steam 数据库数据校准完成，旧假数据已全部清理！");
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 排行榜数据接口
app.get('/api/leaderboard', (req, res) => {
    const query = `
        SELECT player_id, name, region, wins, matches, score,
               ROUND((CAST(wins AS FLOAT) / CAST(CASE WHEN matches = 0 THEN 1 ELSE matches END AS FLOAT)) * 100, 1) as winRate
        FROM players 
        ORDER BY score DESC, wins DESC 
        LIMIT 50000
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

// 核心：基于 SteamID 精准变动分数
app.post('/api/score', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "Forbidden: Invalid API Key" });
    }

    const rawId = req.body.steamId || req.body.playerId || req.body.SteamId || req.body.id;
    if (!rawId) {
        return res.status(400).json({ status: "error", message: "Missing SteamID" });
    }

    const targetSteamId = String(rawId).trim();
    const pureName = cleanName(req.body.name || req.body.playerName);
    const isWin = req.body.isWin === true || req.body.isWin === "true" || req.body.isWin === 1 || req.body.isWin === "1";
    const winIncrement = isWin ? 1 : 0;
    const change = parseInt(req.body.scoreChange || req.body.change || req.body.score) || 0;
    const finalRegion = req.body.region || 'Global';

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, 1, MAX(0, 1000 + ?), CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Unknown' AND excluded.name != '' THEN excluded.name ELSE players.name END,
            region = excluded.region,
            wins = players.wins + ?,
            matches = players.matches + 1,
            score = MAX(0, players.score + ?),
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [targetSteamId, pureName, finalRegion, winIncrement, change, winIncrement, change], function (err) {
        if (err) {
            console.error("[SQL ERROR]:", err.message);
            return res.status(500).json({ status: "error", message: err.message });
        }

        db.get("SELECT player_id, name, score, wins, matches FROM players WHERE player_id = ?", [targetSteamId], (err, row) => {
            console.log(`[同步成功] ID: ${targetSteamId} | 名字: ${row.name} | 本局: ${isWin ? '胜' : '负'} (${change >= 0 ? '+' : ''}${change}) | 当前分: ${row.score} | 总场次: ${row.matches}`);
            res.json({ 
                status: "success", 
                data: row
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
