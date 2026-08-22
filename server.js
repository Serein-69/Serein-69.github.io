const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CRAB_SECRET_KEY_888888";
const STEAM_API_KEY = process.env.STEAM_API_KEY || "YOUR_STEAM_WEB_API_KEY";

// Discord 机器人环境变量（直接在 Railway 面板的 Variables 里配置）
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.use(express.static(__dirname));

function cleanName(name) {
    if (!name) return "Player";
    return String(name)
        .replace(/<color=[^>]*>/gi, '')
        .replace(/<\/color>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[[0-9a-fA-F]{6}\]/g, '')
        .replace(/\[\^[0-9]\]/g, '')
        .replace(/<#[\da-fA-F]+>/g, '')
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
        .replace(/^["']|["']$/g, '')
        .trim() || "Player";
}

async function fetchSteamProfile(steamId) {
    if (!STEAM_API_KEY || STEAM_API_KEY === "YOUR_STEAM_WEB_API_KEY") return null;
    try {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const res = await fetch(url);
        const data = await res.json();
        const player = data?.response?.players?.[0];
        if (!player) return null;

        return {
            personaName: player.personaname || null,
            countryCode: player.loccountrycode ? player.loccountrycode.toUpperCase() : 'GLOBAL'
        };
    } catch (e) {
        return null;
    }
}

let dataFolder = __dirname;
try {
    if (fs.existsSync('/data')) dataFolder = '/data';
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

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE,
            name TEXT NOT NULL,
            region TEXT DEFAULT 'GLOBAL',
            discord_id TEXT,
            wins INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            score INTEGER DEFAULT 1000,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_score ON players(score DESC, wins DESC);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pid ON players(player_id);`);
    console.log("[DB] 数据库服务就绪！");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 排行榜列表查询接口
app.get('/api/leaderboard', (req, res) => {
    const regionFilter = (req.query.region || '').trim().toUpperCase();
    let query = `
        SELECT player_id, name, region, wins, matches, score,
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

// Discord 绑定核心逻辑封装
async function handleBindPlayer(steamId, discordId) {
    const cleanSteamId = String(steamId || "").trim();
    if (!cleanSteamId || !/^\d{17}$/.test(cleanSteamId)) {
        return { success: false, message: "SteamID 格式不正确，必须为 17 位纯数字！" };
    }

    const steamInfo = await fetchSteamProfile(cleanSteamId);
    const country = steamInfo?.countryCode || 'GLOBAL';
    const steamName = cleanName(steamInfo?.personaName || 'Player');

    return new Promise((resolve) => {
        const sql = `
            INSERT INTO players (player_id, name, region, discord_id, wins, matches, score, updated_at)
            VALUES (?, ?, ?, ?, 0, 0, 1000, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                region = excluded.region,
                discord_id = excluded.discord_id,
                updated_at = CURRENT_TIMESTAMP
        `;

        db.run(sql, [cleanSteamId, steamName, country, discordId || null], function (err) {
            if (err) return resolve({ success: false, message: err.message });
            resolve({
                success: true,
                data: { steamId: cleanSteamId, name: steamName, region: country }
            });
        });
    });
}

// 供外部 HTTP 调用的绑定接口
app.post('/api/bot/bind-steam', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    const result = await handleBindPlayer(req.body.steamId, req.body.discordId);
    if (result.success) {
        res.json({ status: "success", data: result.data });
    } else {
        res.status(400).json({ status: "error", message: result.message });
    }
});

// 处理游戏插件上报
async function processReport(body) {
    let steamId = String(body.steamId || body.playerId || "").trim();
    let name = cleanName(body.name || body.playerName);
    let score = null;
    let wins = null;
    let matches = null;

    if (body.rawLine && typeof body.rawLine === 'string') {
        const parts = body.rawLine.split('|');
        if (parts.length > 0 && /^\d+$/.test(parts[0])) steamId = parts[0];
        for (let i = 1; i < parts.length; i++) {
            const [k, ...v] = parts[i].split(':');
            const val = v.join(':');
            if (k === 'Username' && (!name || name === 'Player')) name = cleanName(val);
            if (k === 'CurrentElo') score = parseInt(val);
            if (k === 'Wins') wins = parseInt(val);
            if (k === 'TotalMatches') matches = parseInt(val);
        }
    }

    if (!steamId || !/^\d+$/.test(steamId)) return;

    let region = 'GLOBAL';
    const steamInfo = await fetchSteamProfile(steamId);
    if (steamInfo) {
        if (steamInfo.countryCode) region = steamInfo.countryCode;
        if ((!name || name === 'Player' || name === 'Unknown') && steamInfo.personaName) {
            name = cleanName(steamInfo.personaName);
        }
    }

    if (score === null) score = Math.max(0, 1000 + (parseInt(body.scoreChange) || 0));
    if (wins === null) wins = body.isWin ? 1 : 0;
    if (matches === null) matches = 1;

    const sql = `
        INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
            name = CASE WHEN excluded.name != 'Player' AND excluded.name != 'Unknown' THEN excluded.name ELSE players.name END,
            region = CASE WHEN players.region = 'GLOBAL' THEN excluded.region ELSE players.region END,
            wins = ?,
            matches = ?,
            score = ?,
            updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise(resolve => {
        db.run(sql, [steamId, name, region, wins, matches, score, wins, matches, score], resolve);
    });
}

// 接收 C# 插件 POST 战绩
app.post('/api/score', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey;
    if (apiKey !== SERVER_SECRET_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });

    if (typeof req.body === 'string' && req.body.includes('|')) {
        const lines = req.body.trim().split('\n');
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const stmt = db.prepare(`
                INSERT INTO players (player_id, name, region, wins, matches, score, updated_at)
                VALUES (?, ?, 'GLOBAL', ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_id) DO UPDATE SET
                    name = CASE WHEN players.name = 'Player' OR players.name = 'Unknown' THEN excluded.name ELSE players.name END,
                    wins = MAX(players.wins, excluded.wins),
                    matches = MAX(players.matches, excluded.matches),
                    score = MAX(players.score, excluded.score),
                    updated_at = CURRENT_TIMESTAMP
            `);

            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                const parts = line.split('|');
                const steamId = parts[0];
                if (!steamId || !/^\d+$/.test(steamId)) continue;

                let name = "Player", score = 1000, wins = 0, matches = 0;
                for (let i = 1; i < parts.length; i++) {
                    const [k, ...v] = parts[i].split(':');
                    const val = v.join(':');
                    if (k === 'Username') name = cleanName(val);
                    if (k === 'CurrentElo') score = parseInt(val) || 1000;
                    if (k === 'Wins') wins = parseInt(val) || 0;
                    if (k === 'TotalMatches') matches = parseInt(val) || 0;
                    if (k === 'Losses' && matches === 0) matches = wins + (parseInt(val) || 0);
                }
                if (matches === 0) matches = Math.max(1, wins);
                stmt.run(steamId, name, wins, matches, score);
            }
            stmt.finalize();
            db.run("COMMIT;", () => {
                res.json({ status: "success", message: "本地历史全部同步成功" });
            });
        });
        return;
    }

    if (Array.isArray(req.body)) {
        for (const item of req.body) await processReport(item);
    } else {
        await processReport(req.body);
    }

    res.json({ status: "success" });
});

// =================【 DISCORD 机器人集成启动 】=================
if (DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID) {
    const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    const commands = [
        new SlashCommandBuilder()
            .setName('bind')
            .setDescription('绑定你的 SteamID 并自动识别国籍挂上国旗')
            .addStringOption(option =>
                option.setName('steamid')
                    .setDescription('你的 17 位 Steam64 ID (例如: 76561199115475689)')
                    .setRequired(true)
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

    discordClient.once('ready', async () => {
        console.log(`🤖 Discord 机器人已上线: ${discordClient.user.tag}`);
        try {
            await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
            console.log('✅ Discord /bind 指令注册就绪！');
        } catch (error) {
            console.error('❌ 指令注册失败:', error);
        }
    });

    discordClient.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'bind') {
            const steamId = interaction.options.getString('steamid').trim();
            await interaction.deferReply({ ephemeral: true });

            const result = await handleBindPlayer(steamId, interaction.user.id);

            if (result.success) {
                const { name, region } = result.data;
                let flagEmoji = "🌐";
                if (region && region !== 'GLOBAL' && region.length === 2) {
                    try {
                        const base = 127397;
                        const chars = [...region.toUpperCase()].map(c => c.charCodeAt(0) + base);
                        flagEmoji = String.fromCodePoint(...chars);
                    } catch (e) {
                        flagEmoji = "🌐";
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor(0x9333ea)
                    .setTitle('🎉 账号绑定成功！')
                    .setDescription('你的 Steam 账号已成功与全球天梯排行榜同步。')
                    .addFields(
                        { name: '👤 Steam 昵称', value: `\`${name}\``, inline: true },
                        { name: '🚩 识别国家/地区', value: `${flagEmoji} \`${region}\``, inline: true },
                        { name: '🆔 SteamID', value: `\`${steamId}\``, inline: false }
                    )
                    .setFooter({ text: '全球天梯排行榜已自动更新对应国旗' })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            } else {
                await interaction.editReply({ content: `❌ **绑定失败**: ${result.message}` });
            }
        }
    });

    discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
        console.error("Discord 机器人登录失败:", err.message);
    });
} else {
    console.log("ℹ️ 未配置 DISCORD_BOT_TOKEN，Discord 机器人暂未启动。");
}

app.listen(PORT, () => {
    console.log(`[Server] 服务器与机器人已在端口 ${PORT} 启动！`);
});
