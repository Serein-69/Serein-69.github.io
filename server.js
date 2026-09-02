const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, Events, ActivityType } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";

const DISCORD_CONFIG = {
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,       
    CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
    UPDATE_INTERVAL_MS: 10000                       
};

process.on('uncaughtException', (err) => console.error('[Anti-Crash]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Anti-Crash]:', reason));

let lastDbUpdateTime = Date.now();
const onlineHeartbeats = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, info] of onlineHeartbeats.entries()) {
        if (now - (info.lastTime || info) > 90000) { 
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
        CREATE TABLE IF NOT EXISTS cloud_chat (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            steam_id TEXT NOT NULL,
            user_name TEXT NOT NULL,
            message TEXT NOT NULL,
            is_plus INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS cloud_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_name TEXT NOT NULL,
            author_name TEXT NOT NULL,
            author_steam_id TEXT NOT NULL,
            description TEXT DEFAULT '',
            config_data TEXT NOT NULL,
            downloads INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

app.get('/api/chat/messages', (req, res) => {
    db.all("SELECT id, steam_id, user_name, message, is_plus, strftime('%H:%M', created_at, 'localtime') as time_str FROM cloud_chat ORDER BY id DESC LIMIT 40", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", data: (rows || []).reverse() });
    });
});

app.post('/api/chat/send', (req, res) => {
    const steamId = String(req.body.steamId || '').trim();
    const userName = String(req.body.userName || 'Anonymous').trim();
    const message = String(req.body.message || '').trim();
    const isPlus = req.body.isPlus ? 1 : 0;

    if (!steamId || !message) return res.status(400).json({ status: "error", message: "Empty message" });

    const safeMsg = message.substring(0, 150);

    db.run("INSERT INTO cloud_chat (steam_id, user_name, message, is_plus) VALUES (?, ?, ?, ?)", [steamId, userName, safeMsg, isPlus], function (err) {
        if (err) return res.status(500).json({ status: "error" });
        res.json({ status: "success", messageId: this.lastID });
    });
});

app.get('/api/cloud/configs', (req, res) => {
    db.all("SELECT id, config_name, author_name, author_steam_id, description, downloads, strftime('%Y-%m-%d', created_at, 'localtime') as date_str FROM cloud_configs ORDER BY id DESC LIMIT 100", [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error" });
        res.json({ status: "success", data: rows || [] });
    });
});

app.post('/api/cloud/upload', (req, res) => {
    const configName = String(req.body.configName || 'Custom Profile').trim().substring(0, 30);
    const authorName = String(req.body.authorName || 'User').trim().substring(0, 20);
    const authorSteamId = String(req.body.authorSteamId || '0').trim();
    const description = String(req.body.description || '').trim().substring(0, 100);
    const configData = String(req.body.configData || '').trim();

    if (!configData) return res.status(400).json({ status: "error", message: "Config data is empty" });

    const sql = `INSERT INTO cloud_configs (config_name, author_name, author_steam_id, description, config_data) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [configName, authorName, authorSteamId, description, configData], function (err) {
        if (err) return res.status(500).json({ status: "error" });
        res.json({ status: "success", configId: this.lastID });
    });
});

app.get('/api/cloud/download/:id', (req, res) => {
    const configId = parseInt(req.params.id);
    db.get("SELECT config_name, config_data FROM cloud_configs WHERE id = ?", [configId], (err, row) => {
        if (err || !row) return res.status(404).json({ status: "error", message: "Config not found" });
        db.run("UPDATE cloud_configs SET downloads = downloads + 1 WHERE id = ?", [configId]);
        res.json({ status: "success", name: row.config_name, data: row.config_data });
    });
});

app.get('/api/online', (req, res) => {
    const steamId = String(req.query.id || req.query.steamId || '').trim();
    const customName = String(req.query.name || req.query.username || '').trim();
    const isHidden = req.query.hidden === '1' || req.query.hidden === 'true';

    if (steamId && steamId !== '0') {
        let playerName = customName || "BOT User";
        onlineHeartbeats.set(steamId, {
            lastTime: Date.now(),
            name: playerName,
            hidden: isHidden
        });
    }
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(String(Math.max(1, onlineHeartbeats.size)));
});

app.listen(PORT, () => console.log(`[Server] Service online at port ${PORT}`));
