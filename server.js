const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    Events,
    ActivityType
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || 'CRAB_SECRET_KEY_888888';

const DISCORD_CONFIG = {
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
    UPDATE_INTERVAL_MS: 10000
};

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});

const onlineHeartbeats = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, info] of onlineHeartbeats.entries()) {
        const lastTime = info && info.lastTime ? info.lastTime : info;
        if (now - lastTime > 45000) {
            onlineHeartbeats.delete(key);
        }
    }
}, 5000);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.use(express.static(__dirname));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

let dataFolder = __dirname;
try {
    if (fs.existsSync('/data')) {
        dataFolder = '/data';
    }
} catch (err) {
    dataFolder = __dirname;
}

const dbPath = path.resolve(dataFolder, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[Database] Open failed:', err.message);
        return;
    }
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
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

    db.run(`
        CREATE TABLE IF NOT EXISTS cloud_config_likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_id INTEGER NOT NULL,
            steam_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(config_id, steam_id),
            FOREIGN KEY(config_id) REFERENCES cloud_configs(id) ON DELETE CASCADE
        )
    `);

    // 动态白名单表
    db.run(`
        CREATE TABLE IF NOT EXISTS genesis_whitelist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            steam_id TEXT UNIQUE NOT NULL,
            note TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ★ 核心修复：Railway 健康检查根路由 (防止容器被终止)
app.get('/', (req, res) => {
    res.status(200).send('Server is running OK');
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'success',
        message: 'Server is running',
        time: new Date().toISOString()
    });
});

app.get('/api/version', (req, res) => {
    res.json({
        status: 'success',
        latestVersion: '2.1', 
        downloadUrl: 'https://serein-69githubio-production.up.railway.app/downloads/BOTMenu.dll',
        changelog: '1. 支持全自动云更新\n2. 修复 UI 缩放\n3. 优化在线/离线状态显示'
    });
});

app.get('/api/genesis/version', (req, res) => {
    res.json({
        status: 'success',
        latestVersion: '2.2',
        downloadUrl: 'https://serein-69githubio-production.up.railway.app/downloads/ItemInspectorMod.dll',
        changelog: '1. 动态白名单认证\n2. 自动化存仓与战场闭环'
    });
});

// ==========================================
// 创世纪战白名单核心接口
// ==========================================

// 1. 客户端拉取白名单列表 (纯文本格式)
app.get('/api/genesis/whitelist', (req, res) => {
    db.all(`SELECT steam_id FROM genesis_whitelist ORDER BY id ASC`, [], (err, rows) => {
        if (err) {
            console.error('[Genesis Whitelist] Query failed:', err.message);
            return res.status(500).send('');
        }

        const list = (rows || []).map(r => r.steam_id).join('\n');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.send(list);
    });
});

// 2. API 动态添加 SteamID
app.post('/api/genesis/whitelist/add', (req, res) => {
    const body = req.body || {};
    const secret = body.secret || req.headers['x-secret-key'];

    if (secret !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: 'error', message: 'Forbidden: Invalid secret key' });
    }

    const rawIds = body.steamIds || body.steamId;
    const note = String(body.note || 'API Add').trim();

    if (!rawIds) {
        return res.status(400).json({ status: 'error', message: 'steamId or steamIds required' });
    }

    let idList = [];
    if (Array.isArray(rawIds)) {
        idList = rawIds;
    } else {
        idList = String(rawIds).split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    }

    let insertedCount = 0;
    const stmt = db.prepare(`INSERT OR IGNORE INTO genesis_whitelist (steam_id, note) VALUES (?, ?)`);
    idList.forEach(id => {
        if (/^\d{16,20}$/.test(id)) {
            stmt.run(id, note, function () {
                if (this.changes > 0) insertedCount++;
            });
        }
    });
    stmt.finalize();

    res.json({
        status: 'success',
        totalSubmitted: idList.length,
        message: 'Whitelist updated'
    });
});

// 3. API 动态删除 SteamID
app.post('/api/genesis/whitelist/remove', (req, res) => {
    const body = req.body || {};
    const secret = body.secret || req.headers['x-secret-key'];

    if (secret !== SERVER_SECRET_KEY) {
        return res.status(403).json({ status: 'error', message: 'Forbidden: Invalid secret key' });
    }

    const steamId = String(body.steamId || '').trim();
    if (!steamId) {
        return res.status(400).json({ status: 'error', message: 'steamId is required' });
    }

    db.run(`DELETE FROM genesis_whitelist WHERE steam_id = ?`, [steamId], function (err) {
        if (err) {
            return res.status(500).json({ status: 'error', message: err.message });
        }
        res.json({
            status: 'success',
            deleted: this.changes > 0,
            steamId
        });
    });
});

// ==========================================
// 网页端白名单管理控制台 (/admin/whitelist)
// ==========================================

app.get('/admin/whitelist', (req, res) => {
    db.all(`SELECT id, steam_id, note, created_at FROM genesis_whitelist ORDER BY id DESC`, [], (err, rows) => {
        const listHtml = (rows || []).map(r => `
            <tr>
                <td style="padding:8px; border:1px solid #333;">${r.id}</td>
                <td style="padding:8px; border:1px solid #333; font-family:monospace; font-weight:bold; color:#00ff66;">${r.steam_id}</td>
                <td style="padding:8px; border:1px solid #333;">${r.note || ''}</td>
                <td style="padding:8px; border:1px solid #333; font-size:12px; color:#888;">${r.created_at}</td>
                <td style="padding:8px; border:1px solid #333;">
                    <form method="POST" action="/admin/whitelist/delete" style="display:inline;" onsubmit="return confirm('确定删除该白名单?');">
                        <input type="hidden" name="secret" value="${SERVER_SECRET_KEY}">
                        <input type="hidden" name="steamId" value="${r.steam_id}">
                        <button type="submit" style="background:#ff4444; color:#fff; border:none; padding:4px 8px; cursor:pointer; border-radius:3px;">删除</button>
                    </form>
                </td>
            </tr>
        `).join('');

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>创世纪战 · 白名单管理后台</title></head>
            <body style="background:#121620; color:#fff; font-family:sans-serif; padding:20px; max-width:850px; margin:auto;">
                <h2>创世纪战 · 云端白名单实时管理后台</h2>
                <div style="background:#1c2230; padding:15px; border-radius:6px; margin-bottom:20px;">
                    <h3>添加新白名单 (支持单条或多行批量粘贴)</h3>
                    <form method="POST" action="/admin/whitelist/add">
                        <input type="hidden" name="secret" value="${SERVER_SECRET_KEY}">
                        <p><label>SteamID (每行一个):</label><br>
                        <textarea name="steamIds" rows="5" style="width:100%; box-sizing:border-box; background:#0a0d14; color:#00ff66; border:1px solid #444; padding:8px; font-family:monospace;" placeholder="76561199115475689&#10;76561198272826606" required></textarea></p>
                        <p><label>备注信息 (可选):</label><br>
                        <input type="text" name="note" style="width:100%; box-sizing:border-box; background:#0a0d14; color:#fff; border:1px solid #444; padding:8px;" placeholder="例如: 玩家"></p>
                        <button type="submit" style="background:#00bb44; color:#fff; font-size:14px; font-weight:bold; border:none; padding:8px 20px; cursor:pointer; border-radius:4px;">确认添加至白名单</button>
                    </form>
                </div>
                <h3>当前已授权白名单列表 (共 ${(rows || []).length} 人)</h3>
                <table style="width:100%; border-collapse:collapse; background:#1c2230;">
                    <thead><tr style="background:#252d3d; text-align:left;">
                        <th style="padding:8px; border:1px solid #333;">ID</th>
                        <th style="padding:8px; border:1px solid #333;">SteamID</th>
                        <th style="padding:8px; border:1px solid #333;">备注</th>
                        <th style="padding:8px; border:1px solid #333;">添加时间</th>
                        <th style="padding:8px; border:1px solid #333;">操作</th>
                    </tr></thead>
                    <tbody>${listHtml || '<tr><td colspan="5" style="padding:15px; text-align:center; color:#888;">暂无数据，请在上方添加</td></tr>'}</tbody>
                </table>
            </body>
            </html>
        `);
    });
});

app.post('/admin/whitelist/add', (req, res) => {
    const { secret, steamIds, note } = req.body || {};
    if (secret !== SERVER_SECRET_KEY) return res.status(403).send('无权访问');
    const idList = String(steamIds || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    const stmt = db.prepare(`INSERT OR IGNORE INTO genesis_whitelist (steam_id, note) VALUES (?, ?)`);
    idList.forEach(id => {
        if (/^\d{16,20}$/.test(id)) stmt.run(id, String(note || 'Web Add'));
    });
    stmt.finalize(() => res.redirect('/admin/whitelist'));
});

app.post('/admin/whitelist/delete', (req, res) => {
    const { secret, steamId } = req.body || {};
    if (secret !== SERVER_SECRET_KEY) return res.status(403).send('无权访问');
    db.run(`DELETE FROM genesis_whitelist WHERE steam_id = ?`, [String(steamId).trim()], () => {
        res.redirect('/admin/whitelist');
    });
});

// ==========================================
// 聊天系统与云配置接口
// ==========================================

app.get('/api/chat/messages', (req, res) => {
    const sql = `
        SELECT
            id,
            steam_id,
            user_name,
            message,
            is_plus,
            strftime('%H:%M', created_at, 'localtime') AS time_str
        FROM cloud_chat
        ORDER BY id DESC
        LIMIT 40
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('[Chat] Read failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        const list = (rows || [])
            .map((row) => {
                let isOnline = 0;
                for (const [, info] of onlineHeartbeats.entries()) {
                    if (info && String(info.steamId) === String(row.steam_id)) {
                        isOnline = 1;
                        break;
                    }
                }
                return {
                    ...row,
                    is_online: isOnline
                };
            })
            .reverse();

        res.json({
            status: 'success',
            data: list
        });
    });
});

app.post('/api/chat/send', (req, res) => {
    const body = req.body || {};
    const steamId = String(body.steamId || '').trim();
    const userName = String(body.userName || 'Anonymous').trim().substring(0, 30);
    const message = String(body.message || '').trim().substring(0, 150);
    const isPlus = body.isPlus ? 1 : 0;

    if (!steamId || steamId === '0') {
        return res.status(400).json({
            status: 'error',
            message: 'SteamID is required'
        });
    }

    if (!message) {
        return res.status(400).json({
            status: 'error',
            message: 'Empty message'
        });
    }

    const sql = `
        INSERT INTO cloud_chat
        (steam_id, user_name, message, is_plus)
        VALUES (?, ?, ?, ?)
    `;

    db.run(sql, [steamId, userName, message, isPlus], function (err) {
        if (err) {
            console.error('[Chat] Insert failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        res.json({
            status: 'success',
            messageId: this.lastID
        });
    });
});

app.get('/api/cloud/configs', (req, res) => {
    const steamId = String(req.query.steamId || '').trim();

    const sql = `
        SELECT
            c.id,
            c.config_name,
            c.author_name,
            c.author_steam_id,
            c.description,
            c.downloads,
            COUNT(l.id) AS likes,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM cloud_config_likes ul
                    WHERE ul.config_id = c.id
                    AND ul.steam_id = ?
                )
                THEN 1
                ELSE 0
            END AS liked,
            strftime('%Y-%m-%d', c.created_at, 'localtime') AS date_str
        FROM cloud_configs c
        LEFT JOIN cloud_config_likes l
            ON l.config_id = c.id
        GROUP BY c.id
        ORDER BY c.id DESC
        LIMIT 100
    `;

    db.all(sql, [steamId], (err, rows) => {
        if (err) {
            console.error('[Cloud] Config list failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        res.json({
            status: 'success',
            data: rows || []
        });
    });
});

app.post('/api/cloud/like/:id', (req, res) => {
    const configId = Number.parseInt(req.params.id, 10);
    const body = req.body || {};
    const steamId = String(body.steamId || req.query.steamId || '').trim();
    const shouldLike =
        body.like === true ||
        body.like === 'true' ||
        body.like === 1 ||
        body.like === '1';

    if (!Number.isInteger(configId) || configId <= 0) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid ID'
        });
    }

    if (!steamId || steamId === '0') {
        return res.status(401).json({
            status: 'error',
            message: 'SteamID is required'
        });
    }

    db.get(`SELECT id FROM cloud_configs WHERE id = ?`, [configId], (findErr, config) => {
        if (findErr) {
            console.error('[Cloud] Like lookup failed:', findErr.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        if (!config) {
            return res.status(404).json({
                status: 'error',
                message: 'Config not found'
            });
        }

        if (shouldLike) {
            db.run(
                `INSERT OR IGNORE INTO cloud_config_likes (config_id, steam_id) VALUES (?, ?)`,
                [configId, steamId],
                function (insertErr) {
                    if (insertErr) {
                        console.error('[Cloud] Like failed:', insertErr.message);
                        return res.status(500).json({
                            status: 'error',
                            message: 'Like failed'
                        });
                    }

                    return res.json({
                        status: 'success',
                        liked: true,
                        changed: this.changes > 0
                    });
                }
            );
        } else {
            db.run(
                `DELETE FROM cloud_config_likes WHERE config_id = ? AND steam_id = ?`,
                [configId, steamId],
                function (deleteErr) {
                    if (deleteErr) {
                        console.error('[Cloud] Unlike failed:', deleteErr.message);
                        return res.status(500).json({
                            status: 'error',
                            message: 'Unlike failed'
                        });
                    }

                    return res.json({
                        status: 'success',
                        liked: false,
                        changed: this.changes > 0
                    });
                }
            );
        }
    });
});

app.post('/api/cloud/upload', (req, res) => {
    const body = req.body || {};
    const configName = String(body.configName || 'Custom Profile').trim().substring(0, 30);
    const authorName = String(body.authorName || 'User').trim().substring(0, 20);
    const authorSteamId = String(body.authorSteamId || '').trim();
    const description = String(body.description || '').trim().substring(0, 100);
    const configData = String(body.configData || '').trim();

    if (!authorSteamId || authorSteamId === '0') {
        return res.status(400).json({
            status: 'error',
            message: 'Author SteamID is required'
        });
    }

    if (!configData) {
        return res.status(400).json({
            status: 'error',
            message: 'Config data is empty'
        });
    }

    const sql = `
        INSERT INTO cloud_configs
        (config_name, author_name, author_steam_id, description, config_data)
        VALUES (?, ?, ?, ?, ?)
    `;

    db.run(sql, [configName, authorName, authorSteamId, description, configData], function (err) {
        if (err) {
            console.error('[Cloud] Upload failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        res.json({
            status: 'success',
            configId: this.lastID
        });
    });
});

app.get('/api/cloud/download/:id', (req, res) => {
    const configId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(configId) || configId <= 0) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid ID'
        });
    }

    db.get(`SELECT config_name, config_data FROM cloud_configs WHERE id = ?`, [configId], (err, row) => {
        if (err) {
            console.error('[Cloud] Download lookup failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        if (!row) {
            return res.status(404).json({
                status: 'error',
                message: 'Config not found'
            });
        }

        db.run(`UPDATE cloud_configs SET downloads = downloads + 1 WHERE id = ?`, [configId]);

        res.json({
            status: 'success',
            name: row.config_name,
            data: row.config_data
        });
    });
});

app.post('/api/cloud/delete/:id', (req, res) => {
    const configId = Number.parseInt(req.params.id, 10);
    const body = req.body || {};
    const steamId = String(body.steamId || req.query.steamId || '').trim();

    if (!Number.isInteger(configId) || configId <= 0) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid ID'
        });
    }

    if (!steamId || steamId === '0') {
        return res.status(401).json({
            status: 'error',
            message: 'SteamID is required'
        });
    }

    db.get(`SELECT id, author_steam_id FROM cloud_configs WHERE id = ?`, [configId], (err, row) => {
        if (err) {
            console.error('[Cloud] Delete lookup failed:', err.message);
            return res.status(500).json({
                status: 'error',
                message: 'Database error'
            });
        }

        if (!row) {
            return res.status(404).json({
                status: 'error',
                message: 'Config not found'
            });
        }

        const authorSteamId = String(row.author_steam_id || '').trim();
        if (!authorSteamId || authorSteamId !== steamId) {
            return res.status(403).json({
                status: 'error',
                message: 'Unauthorized'
            });
        }

        db.run(`DELETE FROM cloud_configs WHERE id = ? AND author_steam_id = ?`, [configId, steamId], function (deleteErr) {
            if (deleteErr) {
                console.error('[Cloud] Delete failed:', deleteErr.message);
                return res.status(500).json({
                    status: 'error',
                    message: 'Delete failed'
                });
            }

            if (this.changes === 0) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Unauthorized'
                });
            }

            return res.json({
                status: 'success',
                deleted: true,
                configId
            });
        });
    });
});

app.get('/api/online', (req, res) => {
    const steamId = String(req.query.id || req.query.steamId || '').trim();
    const customName = String(req.query.name || req.query.username || '').trim();
    const isHidden = req.query.hidden === '1' || req.query.hidden === 'true';
    const clientId = String(req.query.clientId || steamId).trim();

    if (clientId && clientId !== '0') {
        onlineHeartbeats.set(clientId, {
            lastTime: Date.now(),
            name: customName || 'BOT User',
            hidden: isHidden,
            steamId: steamId
        });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(String(Math.max(1, onlineHeartbeats.size)));
});

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

let liveStatusMessage = null;

discordClient.once(Events.ClientReady, async () => {
    try {
        console.log(`[Discord] Logged in as ${discordClient.user.tag}`);

        const channel = await discordClient.channels
            .fetch(DISCORD_CONFIG.CHANNEL_ID)
            .catch(() => null);

        if (!channel) {
            console.error('[Discord] Channel not found');
            return;
        }

        const messages = await channel.messages
            .fetch({ limit: 10 })
            .catch(() => null);

        if (messages) {
            liveStatusMessage = messages.find(
                (message) => message.author.id === discordClient.user.id
            );
        }

        await updateDiscordLiveMessage(channel);

        setInterval(
            () => updateDiscordLiveMessage(channel),
            DISCORD_CONFIG.UPDATE_INTERVAL_MS
        );
    } catch (err) {
        console.error('[Discord] Initialization failed:', err.message);
    }
});

async function updateDiscordLiveMessage(channel) {
    if (!channel) return;

    const totalOnlineCount = onlineHeartbeats.size;
    const now = new Date();
    const timeString = now.toTimeString().split(' ')[0] + ' UTC';

    const visiblePlayersList = [];
    let hiddenPlayersCount = 0;

    for (const [, info] of onlineHeartbeats.entries()) {
        if (info.hidden) {
            hiddenPlayersCount++;
        } else {
            visiblePlayersList.push({
                steamId: info.steamId || '',
                name: info.name || 'BOT User'
            });
        }
    }

    let playerListContent = '';

    if (totalOnlineCount === 0) {
        playerListContent = '> *No players currently online*';
    } else {
        const lines = visiblePlayersList
            .slice(0, 20)
            .map((player, index) => `\`${index + 1}.\` **${player.name}** (\`${player.steamId}\`)`);

        if (visiblePlayersList.length > 20) {
            lines.push(`> *...and ${visiblePlayersList.length - 20} more visible players*`);
        }

        if (hiddenPlayersCount > 0) {
            lines.push(`> **Hidden / Incognito Players:** \`${hiddenPlayersCount}\` player(s)`);
        }

        playerListContent = lines.join('\n');
    }

    const statusEmbed = new EmbedBuilder()
        .setColor(totalOnlineCount > 0 ? 0x00FF44 : 0xFF4444)
        .setTitle('✦ BOT MENU — LIVE STATUS MONITOR ✦')
        .setDescription(
            `### Active Online Users\n` +
            `# \`  ${totalOnlineCount} Online  \`\n\n` +
            `### Current Online Player List\n` +
            `${playerListContent}\n\n` +
            `> **Mod Status:** \`Undetected (Active)\`\n` +
            `> **Version:** \`v2.1\`\n` +
            `> **Last Updated:** \`${timeString}\``
        )
        .setFooter({
            text: 'BOT Menu Mod • Live Auto-Update'
        })
        .setTimestamp();

    try {
        if (!liveStatusMessage) {
            liveStatusMessage = await channel.send({
                embeds: [statusEmbed],
                components: []
            });
        } else {
            await liveStatusMessage.edit({
                embeds: [statusEmbed],
                components: []
            });
        }

        if (discordClient.user) {
            discordClient.user.setActivity(
                `${totalOnlineCount} Online User(s)`,
                { type: ActivityType.Watching }
            );
        }
    } catch (err) {
        console.error('[Discord] Status update failed:', err.message);
        if (err.code === 10008) {
            liveStatusMessage = null;
        }
    }
}

if (DISCORD_CONFIG.BOT_TOKEN && !DISCORD_CONFIG.BOT_TOKEN.includes('填入你的')) {
    discordClient.login(DISCORD_CONFIG.BOT_TOKEN).catch((err) => {
        console.error('[Discord] Login failed:', err.message);
    });
} else {
    console.log('[Discord] Bot token not configured');
}

// 绑定 0.0.0.0 保证 Railway 网络穿透
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Online on port ${PORT}`);
    console.log(`[Server] Database: ${dbPath}`);
});
