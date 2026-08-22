const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = "CRAB_SECRET_KEY_888888";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());
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

function getCountryCodeByIP(ip, callback) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return callback('Global');
    const cleanIp = ip.split(',')[0].trim().replace(/^.*:/, '');
    const url = `http://ip-api.com/json/${cleanIp}?fields=status,countryCode`;

    http.get(url, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
            try {
                const parsed = JSON.parse(rawData);
                if (parsed.status === 'success' && parsed.countryCode) {
                    return callback(parsed.countryCode.toUpperCase());
                }
            } catch (e) {}
            callback('Global');
        });
    }).on('error', () => {
        callback('Global');
    });
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
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'Global',
            bind_key TEXT,
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS access_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_code TEXT UNIQUE,
            bound_steam_id TEXT,
            status TEXT DEFAULT 'unassigned',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            bound_at DATETIME
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_region ON players(region);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);

    console.log("[DB] 数据库服务已就绪！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. 排行榜接口
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

// 2. 录入密钥接口
app.post('/api/admin/keys', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const { keys } = req.body;
    if (!keys) return res.status(400).json({ status: "error", message: "缺少密钥列表" });

    const keyList = Array.isArray(keys) ? keys : String(keys).split(/[\r\n,]+/);
    const stmt = db.prepare(`INSERT INTO access_keys (key_code, status) VALUES (?, 'unassigned') ON CONFLICT(key_code) DO NOTHING`);

    db.serialize(() => {
        db.run("BEGIN TRANSACTION;");
        keyList.forEach(k => {
            const cleanKey = k.trim();
            if (cleanKey.length > 3) stmt.run(cleanKey);
        });
        stmt.finalize();
        db.run("COMMIT;", () => {
            res.json({ status: "success", message: `成功录入密钥！` });
        });
    });
});

// 3. 游戏内绑定接口
app.post('/api/bind', (req, res) => {
    const { steamId, keyCode } = req.body;
    if (!steamId || !keyCode) {
        return res.status(400).json({ status: "error", message: "缺少 SteamID 或密钥" });
    }

    const cleanKey = keyCode.trim();
    const cleanSteamId = String(steamId).trim();

    db.get("SELECT * FROM access_keys WHERE key_code = ?", [cleanKey], (err, keyRecord) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        if (!keyRecord) {
            return res.status(404).json({ status: "error", message: "密钥无效！" });
        }
        if (keyRecord.status === 'bound' && keyRecord.bound_steam_id !== cleanSteamId) {
            return res.status(400).json({ status: "error", message: "该密钥已被其他账号绑定！" });
        }

        db.run("UPDATE access_keys SET bound_steam_id = ?, status = 'bound', bound_at = CURRENT_TIMESTAMP WHERE key_code = ?", 
            [cleanSteamId, cleanKey], () => {
                db.run("UPDATE players SET bind_key = ? WHERE player_id = ?", [cleanKey, cleanSteamId]);
                res.json({ status: "success", message: "绑定成功！" });
            }
        );
    });
});

// 4. 战绩上传接口
app.post('/api/score', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: "error", message: "Forbidden: Invalid API Key" });
    }

    let targetSteamId = "";
    let pureName = "Unknown";
    let isWin = false;
    let change = 0;
    let directScore = null;
    let directWins = null;
    let directMatches = null;

    let rawText = typeof req.body === 'string' ? req.body : (req.body.rawLine || "");
    if (rawText && rawText.includes('|')) {
        const segments = rawText.split('|');
        targetSteamId = segments[0].trim();

        segments.forEach(seg => {
            const [k, v] = seg.split(':');
            if (k && v) {
                const key = k.trim().toLowerCase();
                const val = v.trim();
                if (key === 'username') pureName = cleanName(val);
                if (key === 'currentelo') directScore = parseInt(val, 10);
                if (key === 'wins') directWins = parseInt(val, 10);
                if (key === 'totalmatches') directMatches = parseInt(val, 10);
            }
        });
    } else {
        targetSteamId = String(req.body.steamId || req.body.playerId || req.body.id || "").trim();
        pureName = cleanName(req.body.name || req.body.playerName);
        isWin = req.body.isWin === true || req.body.isWin === "true" || req.body.isWin === 1 || req.body.isWin === "1";
        change = parseInt(req.body.scoreChange || req.body.change || req.body.score) || 0;
    }

    if (!targetSteamId || !/^\d+$/.test(targetSteamId)) {
        return res.status(400).json({ status: "error", message: "Missing or invalid SteamID" });
    }

    const winIncrement = isWin ? 1 : 0;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    getCountryCodeByIP(clientIp, (detectedCountry) => {
        let sql = "";
        let params = [];

        if (directScore !== null) {
            sql = `
                INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_id) DO UPDATE SET
                    name = excluded.name,
                    region = CASE WHEN excluded.region != 'Global' THEN excluded.region ELSE players.region END,
                    wins = excluded.wins,
                    matches = excluded.matches,
                    score = excluded.score,
                    updated_at = CURRENT_TIMESTAMP
            `;
            params = [targetSteamId, pureName, detectedCountry, directWins || 0, directMatches || 0, directScore];
        } else {
            sql = `
                INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
                VALUES (?, ?, ?, ?, 1, MAX(0, 1000 + ?), CURRENT_TIMESTAMP)
                ON CONFLICT(player_id) DO UPDATE SET
                    name = CASE WHEN excluded.name != 'Unknown' AND excluded.name != '' THEN excluded.name ELSE players.name END,
                    region = CASE WHEN excluded.region != 'Global' THEN excluded.region ELSE players.region END,
                    wins = players.wins + ?,
                    matches = players.matches + 1,
                    score = MAX(0, players.score + ?),
                    updated_at = CURRENT_TIMESTAMP
            `;
            params = [targetSteamId, pureName, detectedCountry, winIncrement, change, winIncrement, change];
        }

        db.run(sql, params, function (err) {
            if (err) return res.status(500).json({ status: "error", message: err.message });

            db.get("SELECT player_id, name, region, score, wins, matches FROM players WHERE player_id = ?", [targetSteamId], (err, row) => {
                res.json({ status: "success", data: row });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
