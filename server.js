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
    if (err) console.error("Database error:", err.message);
    else {
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
    }
});

const legacyPlayers = [
    { id: "legacy_1", name: "Habibidope", score: 1545, wins: 346, matches: 458 },
    { id: "legacy_2", name: "shu", score: 1538, wins: 142, matches: 181 },
    { id: "legacy_3", name: "Smart", score: 1491, wins: 78, matches: 109 },
    { id: "legacy_4", name: "de", score: 1471, wins: 82, matches: 123 },
    { id: "legacy_5", name: "soh", score: 1466, wins: 101, matches: 135 },
    { id: "legacy_6", name: "cousins by birth", score: 1460, wins: 105, matches: 137 },
    { id: "legacy_7", name: "dedeador de panchas", score: 1438, wins: 225, matches: 326 },
    { id: "legacy_8", name: "yogi30dee", score: 1433, wins: 39, matches: 52 },
    { id: "legacy_9", name: "xzqre", score: 1408, wins: 31, matches: 35 },
    { id: "legacy_10", name: "sin of pride", score: 1398, wins: 51, matches: 72 },
    { id: "legacy_11", name: "Dipsy", score: 1392, wins: 345, matches: 570 },
    { id: "legacy_12", name: "worstplayer", score: 1385, wins: 116, matches: 172 },
    { id: "legacy_13", name: "4K", score: 1364, wins: 20, matches: 21 },
    { id: "legacy_14", name: "Silo", score: 1359, wins: 239, matches: 482 },
    { id: "legacy_15", name: "AGoodRun", score: 1352, wins: 38, matches: 53 },
    { id: "legacy_16", name: "12Isaac", score: 1347, wins: 542, matches: 889 },
    { id: "legacy_17", name: "foids are evil", score: 1346, wins: 84, matches: 114 },
    { id: "legacy_18", name: "Angel$$avior$$", score: 1345, wins: 115, matches: 174 },
    { id: "legacy_19", name: "Godzy", score: 1344, wins: 28, matches: 35 },
    { id: "legacy_20", name: "! Copium !", score: 1340, wins: 97, matches: 142 },
    { id: "legacy_21", name: "Stef", score: 1328, wins: 190, matches: 329 },
    { id: "legacy_22", name: "astonperez_crabgam", score: 1325, wins: 17, matches: 17 },
    { id: "legacy_23", name: "re", score: 1323, wins: 430, matches: 642 },
    { id: "legacy_24", name: "Dawnover", score: 1321, wins: 119, matches: 191 },
    { id: "legacy_25", name: "xxx", score: 1319, wins: 110, matches: 157 },
    { id: "legacy_26", name: "dreko's sugar daddy", score: 1310, wins: 29, matches: 35 },
    { id: "legacy_27", name: "custom os", score: 1305, wins: 58, matches: 94 },
    { id: "legacy_28", name: "Astolfo", score: 1303, wins: 588, matches: 909 },
    { id: "legacy_29", name: "dancc", score: 1270, wins: 218, matches: 341 },
    { id: "legacy_30", name: "carmelo wizzerstand", score: 1269, wins: 237, matches: 394 },
    { id: "legacy_31", name: "vaca saturnita", score: 1269, wins: 42, matches: 68 },
    { id: "legacy_32", name: "Storm", score: 1268, wins: 77, matches: 129 },
    { id: "legacy_33", name: "zZz", score: 1260, wins: 35, matches: 50 },
    { id: "legacy_34", name: "RayouteGuardz", score: 1258, wins: 26, matches: 30 },
    { id: "legacy_35", name: "mymy", score: 1256, wins: 34, matches: 55 },
    { id: "legacy_36", name: "afek4", score: 1255, wins: 59, matches: 108 },
    { id: "legacy_37", name: "Collapse", score: 1251, wins: 22, matches: 31 },
    { id: "legacy_38", name: "Lr", score: 1250, wins: 37, matches: 60 },
    { id: "legacy_39", name: "Albion", score: 1249, wins: 346, matches: 625 },
    { id: "legacy_40", name: "ShartAttack", score: 1247, wins: 51, matches: 75 },
    { id: "legacy_41", name: "Eq~Uwu", score: 1246, wins: 25, matches: 36 },
    { id: "legacy_42", name: "koyznwiy7632", score: 1245, wins: 48, matches: 83 },
    { id: "legacy_43", name: "顾言.", score: 1243, wins: 26, matches: 39 },
    { id: "legacy_44", name: "Bendis", score: 1238, wins: 38, matches: 59 },
    { id: "legacy_45", name: "TheloniousYT", score: 1235, wins: 48, matches: 83 },
    { id: "legacy_46", name: "The wind carries your name", score: 1231, wins: 348, matches: 542 },
    { id: "legacy_47", name: "JV", score: 1230, wins: 31, matches: 42 },
    { id: "legacy_48", name: "yassou95000", score: 1228, wins: 63, matches: 103 },
    { id: "legacy_49", name: "slut", score: 1227, wins: 37, matches: 66 },
    { id: "legacy_50", name: "snakexhild", score: 1221, wins: 48, matches: 79 },
    { id: "legacy_51", name: "Sxpphire", score: 1216, wins: 135, matches: 257 },
    { id: "legacy_52", name: "orange", score: 1215, wins: 34, matches: 55 },
    { id: "legacy_53", name: "score", score: 1214, wins: 60, matches: 92 },
    { id: "legacy_54", name: "wasd", score: 1213, wins: 20, matches: 25 },
    { id: "legacy_55", name: "#PVS Laik Anime Kızı", score: 1208, wins: 16, matches: 23 },
    { id: "legacy_56", name: "Unknown_56", score: 1204, wins: 71, matches: 118 },
    { id: "legacy_57", name: "well47", score: 1204, wins: 18, matches: 23 },
    { id: "legacy_58", name: "theheatedsandv", score: 1201, wins: 42, matches: 71 },
    { id: "legacy_59", name: "tek", score: 1200, wins: 14, matches: 25 },
    { id: "legacy_60", name: "billy", score: 1197, wins: 44, matches: 77 },
    { id: "legacy_61", name: "Unknown_61", score: 1195, wins: 100, matches: 164 },
    { id: "legacy_62", name: "What color is my skeleton?", score: 1191, wins: 10, matches: 11 },
    { id: "legacy_63", name: "[GUILD] BingoBango", score: 1187, wins: 28, matches: 49 },
    { id: "legacy_64", name: "o7Moon", score: 1181, wins: 51, matches: 88 },
    { id: "legacy_65", name: "Unknown_65", score: 1179, wins: 45, matches: 65 },
    { id: "legacy_66", name: "intokyownghoul", score: 1176, wins: 18, matches: 28 },
    { id: "legacy_67", name: "FLAГSTRИK", score: 1176, wins: 34, matches: 64 },
    { id: "legacy_68", name: "Noct", score: 1174, wins: 300, matches: 565 },
    { id: "legacy_69", name: "ЖИРНОГОЛОВЫЙ", score: 1173, wins: 13, matches: 16 },
    { id: "legacy_70", name: "HIRT İBO", score: 1170, wins: 11, matches: 12 },
    { id: "legacy_71", name: "vova_minecraft", score: 1168, wins: 16, matches: 23 },
    { id: "legacy_72", name: "kruuuu", score: 1160, wins: 433, matches: 883 },
    { id: "legacy_73", name: "p1xma", score: 1156, wins: 19, matches: 25 },
    { id: "legacy_74", name: "js another life altering event", score: 1154, wins: 14, matches: 18 },
    { id: "legacy_75", name: "Unknown_75", score: 1152, wins: 34, matches: 74 },
    { id: "legacy_76", name: "Seu 1925", score: 1152, wins: 17, matches: 25 },
    { id: "legacy_77", name: "DAY1", score: 1151, wins: 19, matches: 32 },
    { id: "legacy_78", name: "BOMBA SKIAK MR (бабай)", score: 1150, wins: 27, matches: 47 },
    { id: "legacy_79", name: "crab game's hero", score: 1148, wins: 10, matches: 10 },
    { id: "legacy_80", name: "nazwa profilu", score: 1147, wins: 50, matches: 84 },
    { id: "legacy_81", name: "KOSHENYA", score: 1143, wins: 109, matches: 231 },
    { id: "legacy_82", name: "✘adaanha✘", score: 1142, wins: 118, matches: 244 },
    { id: "legacy_83", name: "6ix9ine", score: 1139, wins: 14, matches: 25 },
    { id: "legacy_84", name: "K,Gambit", score: 1139, wins: 14, matches: 21 },
    { id: "legacy_85", name: "NOIR ॐ", score: 1137, wins: 13, matches: 16 },
    { id: "legacy_86", name: "Unknown_86", score: 1137, wins: 49, matches: 94 },
    { id: "legacy_87", name: "Unknown_87", score: 1134, wins: 425, matches: 783 },
    { id: "legacy_88", name: "wachin de goma", score: 1134, wins: 10, matches: 10 },
    { id: "legacy_89", name: "billie", score: 1134, wins: 18, matches: 41 },
    { id: "legacy_90", name: "Kaizen", score: 1133, wins: 12, matches: 16 },
    { id: "legacy_91", name: "zombieslayer", score: 1132, wins: 12, matches: 15 },
    { id: "legacy_92", name: "Roulacase", score: 1131, wins: 7, matches: 7 },
    { id: "76561199115475689", name: "Serein", score: 1125, wins: 62, matches: 101 },
    { id: "legacy_94", name: "russo", score: 1125, wins: 7, matches: 7 },
    { id: "legacy_95", name: "Z._.R", score: 1122, wins: 14, matches: 22 },
    { id: "legacy_96", name: "haru", score: 1122, wins: 9, matches: 11 },
    { id: "legacy_97", name: "Unknown_97", score: 1121, wins: 8, matches: 10 },
    { id: "legacy_98", name: "XLR8", score: 1119, wins: 12, matches: 19 },
    { id: "legacy_99", name: "[PFF] Astal", score: 1117, wins: 16, matches: 29 },
    { id: "legacy_100", name: "wit", score: 1117, wins: 50, matches: 111 }
];

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
    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC);`);

    const stmt = db.prepare(`
        INSERT INTO players (player_id, name, region, wins, matches, score)
        VALUES (?, ?, 'Global', ?, ?, ?)
        ON CONFLICT(player_id) DO NOTHING
    `);

    legacyPlayers.forEach(p => {
        stmt.run(p.id, cleanName(p.name), p.wins, p.matches, p.score);
    });
    stmt.finalize();
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
        LIMIT 5000
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

    const change = parseInt(scoreChange) || 0;
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

    db.run(sql, [playerId, pureName, finalRegion, winIncrement, change, winIncrement, change], function (err) {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ status: "error", message: err.message });
        }
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

app.listen(PORT);
