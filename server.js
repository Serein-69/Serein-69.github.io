const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

const ADMIN_STEAM_IDS = [
    "76561199115475689"
];

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Unknown";
    return name.replace(/<[^>]*>/g, '').trim();
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
    if (err) console.error("Database connection error:", err.message);
    else console.log("Database connected at:", dbPath);
});

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
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/leaderboard', (req, res) => {
    const query = `
        SELECT player_id, name, region, wins, matches, score,
               ROUND((CAST(wins AS FLOAT) / CAST(CASE WHEN matches = 0 THEN 1 ELSE matches END AS FLOAT)) * 100, 1) as winRate
        FROM players 
        ORDER BY score DESC 
        LIMIT 100
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: rows || [] });
    });
});

app.post('/api/score', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "Forbidden" });
    }

    const { playerId, name, region, isWin, scoreChange } = req.body;
    if (!playerId) return res.status(400).json({ status: "error", message: "Missing playerId" });

    const pureName = cleanName(name);
    const winIncrement = isWin ? 1 : 0;
    const finalRegion = region || 'Global';

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, 1, 1000 + ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = excluded.name,
            region = excluded.region,
            wins = players.wins + ?,
            matches = players.matches + 1,
            score = MAX(0, players.score + ?),
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(sql, [playerId, pureName, finalRegion, winIncrement, scoreChange || 0, winIncrement, scoreChange || 0], function (err) {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ status: "error", message: err.message });
        }
        console.log(`[Score Uploaded] ${pureName} (${playerId}): ${scoreChange > 0 ? '+' : ''}${scoreChange}`);
        res.json({ status: "success" });
    });
});

app.post('/api/admin/verify', (req, res) => {
    const { steamId } = req.body;
    if (steamId && ADMIN_STEAM_IDS.includes(steamId.trim())) {
        res.json({ status: "success" });
    } else {
        res.status(403).json({ status: "error" });
    }
});

app.delete('/api/admin/player/:playerId', (req, res) => {
    const adminSteamId = req.headers['x-admin-id'];
    if (!adminSteamId || !ADMIN_STEAM_IDS.includes(adminSteamId.trim())) {
        return res.status(403).json({ status: "error" });
    }

    const targetPlayerId = req.params.playerId;
    db.run("DELETE FROM players WHERE player_id = ?", [targetPlayerId], function (err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success" });
    });
});

app.listen(PORT, () => {
    console.log("Server listening on port", PORT);
});
