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

const SERVER_SECRET_KEY =
    process.env.SERVER_SECRET_KEY || 'CRAB_SECRET_KEY_888888';

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

    for (const [steamId, info] of onlineHeartbeats.entries()) {
        const lastTime = info && info.lastTime
            ? info.lastTime
            : info;

        if (now - lastTime > 90000) {
            onlineHeartbeats.delete(steamId);
        }
    }
}, 10000);

app.use(cors());

app.use(express.json({
    limit: '100mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '100mb'
}));

app.use(express.text({
    limit: '100mb'
}));

app.use(express.static(__dirname));

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

    console.log('[Database] Connected:', dbPath);

    db.run('PRAGMA journal_mode = WAL;', (pragmaErr) => {
        if (pragmaErr) {
            console.error('[Database] WAL error:', pragmaErr.message);
        }
    });

    db.run('PRAGMA synchronous = NORMAL;', (pragmaErr) => {
        if (pragmaErr) {
            console.error('[Database] Synchronous error:', pragmaErr.message);
        }
    });
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

app.get('/api/health', (req, res) => {
    res.json({
        status: 'success',
        message: 'Server is running',
        time: new Date().toISOString()
    });
});

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
            .map((row) => ({
                ...row,
                is_online: onlineHeartbeats.has(String(row.steam_id))
                    ? 1
                    : 0
            }))
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
    const userName = String(body.userName || 'Anonymous')
        .trim()
        .substring(0, 30);

    const message = String(body.message || '')
        .trim()
        .substring(0, 150);

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

    db.run(
        sql,
        [steamId, userName, message, isPlus],
        function (err) {
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
        }
    );
});

app.get('/api/cloud/configs', (req, res) => {
    const sql = `
        SELECT
            id,
            config_name,
            author_name,
            author_steam_id,
            description,
            downloads,
            strftime('%Y-%m-%d', created_at, 'localtime') AS date_str
        FROM cloud_configs
        ORDER BY id DESC
        LIMIT 100
    `;

    db.all(sql, [], (err, rows) => {
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

app.post('/api/cloud/upload', (req, res) => {
    const body = req.body || {};

    const configName = String(body.configName || 'Custom Profile')
        .trim()
        .substring(0, 30);

    const authorName = String(body.authorName || 'User')
        .trim()
        .substring(0, 20);

    const authorSteamId = String(body.authorSteamId || '')
        .trim();

    const description = String(body.description || '')
        .trim()
        .substring(0, 100);

    const configData = String(body.configData || '')
        .trim();

    if (!authorSteamId || authorSteamId === '0') {
        return res.status(400).json({
            status: 'error',
            message: 'Author SteamID is required'
        });
    }

    if (!configData) {
        return res.status(400).json({
            status: '400',
            message: 'Config data is empty'
        });
    }

    const sql = `
        INSERT INTO cloud_configs
        (
            config_name,
            author_name,
            author_steam_id,
            description,
            config_data
        )
        VALUES (?, ?, ?, ?, ?)
    `;

    db.run(
        sql,
        [
            configName,
            authorName,
            authorSteamId,
            description,
            configData
        ],
        function (err) {
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
        }
    );
});

app.get('/api/cloud/download/:id', (req, res) => {
    const configId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(configId) || configId <= 0) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid ID'
        });
    }

    db.get(
        `
        SELECT
            config_name,
            config_data
        FROM cloud_configs
        WHERE id = ?
        `,
        [configId],
        (err, row) => {
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

            db.run(
                `
                UPDATE cloud_configs
                SET downloads = downloads + 1
                WHERE id = ?
                `,
                [configId],
                (updateErr) => {
                    if (updateErr) {
                        console.error(
                            '[Cloud] Download counter failed:',
                            updateErr.message
                        );
                    }
                }
            );

            res.json({
                status: 'success',
                name: row.config_name,
                data: row.config_data
            });
        }
    );
});

app.post('/api/cloud/delete/:id', (req, res) => {
    const configId = Number.parseInt(req.params.id, 10);

    const body = req.body || {};

    const steamId = String(
        body.steamId ||
        req.query.steamId ||
        ''
    ).trim();

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

    db.get(
        `
        SELECT
            id,
            author_steam_id
        FROM cloud_configs
        WHERE id = ?
        `,
        [configId],
        (err, row) => {
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

            const authorSteamId = String(
                row.author_steam_id || ''
            ).trim();

            if (!authorSteamId || authorSteamId !== steamId) {
                console.warn(
                    `[Cloud] Unauthorized delete attempt. ` +
                    `config=${configId}, requester=${steamId}`
                );

                return res.status(403).json({
                    status: 'error',
                    message: 'Unauthorized'
                });
            }

            db.run(
                `
                DELETE FROM cloud_configs
                WHERE id = ?
                AND author_steam_id = ?
                `,
                [configId, steamId],
                function (deleteErr) {
                    if (deleteErr) {
                        console.error(
                            '[Cloud] Delete failed:',
                            deleteErr.message
                        );

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

                    console.log(
                        `[Cloud] Config ${configId} deleted by ${steamId}`
                    );

                    return res.json({
                        status: 'success',
                        deleted: true,
                        configId
                    });
                }
            );
        }
    );
});

app.get('/api/online', (req, res) => {
    const steamId = String(
        req.query.id ||
        req.query.steamId ||
        ''
    ).trim();

    const customName = String(
        req.query.name ||
        req.query.username ||
        ''
    ).trim();

    const isHidden =
        req.query.hidden === '1' ||
        req.query.hidden === 'true';

    if (steamId && steamId !== '0') {
        onlineHeartbeats.set(steamId, {
            lastTime: Date.now(),
            name: customName || 'BOT User',
            hidden: isHidden
        });
    }

    res.setHeader(
        'Content-Type',
        'text/plain; charset=utf-8'
    );

    res.send(
        String(Math.max(1, onlineHeartbeats.size))
    );
});

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

let liveStatusMessage = null;

discordClient.once(
    Events.ClientReady,
    async () => {
        try {
            console.log(
                `[Discord] Logged in as ${discordClient.user.tag}`
            );

            const channel = await discordClient.channels
                .fetch(DISCORD_CONFIG.CHANNEL_ID)
                .catch(() => null);

            if (!channel) {
                console.error(
                    '[Discord] Channel not found'
                );
                return;
            }

            const messages = await channel.messages
                .fetch({ limit: 10 })
                .catch(() => null);

            if (messages) {
                liveStatusMessage = messages.find(
                    (message) =>
                        message.author.id === discordClient.user.id
                );
            }

            await updateDiscordLiveMessage(channel);

            setInterval(
                () => updateDiscordLiveMessage(channel),
                DISCORD_CONFIG.UPDATE_INTERVAL_MS
            );
        } catch (err) {
            console.error(
                '[Discord] Initialization failed:',
                err.message
            );
        }
    }
);

async function updateDiscordLiveMessage(channel) {
    if (!channel) return;

    const totalOnlineCount =
        onlineHeartbeats.size;

    const now = new Date();

    const timeString =
        now.toTimeString().split(' ')[0] +
        ' UTC';

    const visiblePlayersList = [];
    let hiddenPlayersCount = 0;

    for (const [steamId, info] of onlineHeartbeats.entries()) {
        if (info.hidden) {
            hiddenPlayersCount++;
        } else {
            visiblePlayersList.push({
                steamId,
                name: info.name || 'BOT User'
            });
        }
    }

    let playerListContent = '';

    if (totalOnlineCount === 0) {
        playerListContent =
            '> *No players currently online*';
    } else {
        const lines = visiblePlayersList
            .slice(0, 20)
            .map((player, index) => {
                return (
                    `\`${index + 1}.\` ` +
                    `**${player.name}** ` +
                    `(\`${player.steamId}\`)`
                );
            });

        if (visiblePlayersList.length > 20) {
            lines.push(
                `> *...and ${visiblePlayersList.length - 20} more visible players*`
            );
        }

        if (hiddenPlayersCount > 0) {
            lines.push(
                `> **Hidden / Incognito Players:** ` +
                `\`${hiddenPlayersCount}\` player(s)`
            );
        }

        playerListContent = lines.join('\n');
    }

    const statusEmbed = new EmbedBuilder()
        .setColor(
            totalOnlineCount > 0
                ? 0x00FF44
                : 0xFF4444
        )
        .setTitle(
            '✦ BOT MENU — LIVE STATUS MONITOR ✦'
        )
        .setDescription(
            `### Active Online Users\n` +
            `# \`  ${totalOnlineCount} Online  \`\n\n` +
            `### Current Online Player List\n` +
            `${playerListContent}\n\n` +
            `> **Mod Status:** \`Undetected (Active)\`\n` +
            `> **Version:** \`v2.0\`\n` +
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
                {
                    type: ActivityType.Watching
                }
            );
        }
    } catch (err) {
        console.error(
            '[Discord] Status update failed:',
            err.message
        );

        if (err.code === 10008) {
            liveStatusMessage = null;
        }
    }
}

if (
    DISCORD_CONFIG.BOT_TOKEN &&
    !DISCORD_CONFIG.BOT_TOKEN.includes('填入你的')
) {
    discordClient.login(
        DISCORD_CONFIG.BOT_TOKEN
    ).catch((err) => {
        console.error(
            '[Discord] Login failed:',
            err.message
        );
    });
} else {
    console.log(
        '[Discord] Bot token not configured'
    );
}

app.listen(PORT, () => {
    console.log(
        `[Server] Online on port ${PORT}`
    );

    console.log(
        `[Server] Port: ${PORT}`
    );

    console.log(
        `[Server] Database: ${dbPath}`
    );
});
