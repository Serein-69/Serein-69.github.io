// playersData.js
const fs = require('fs');
const path = require('path');

// 强力清洗所有 Unity 富文本颜色代码与特殊不可见符号
function stripTags(str) {
    if (!str) return "Unknown";
    return String(str)
        .replace(/<color=[^>]*>/gi, '')   // 去除 <color=#xxx>
        .replace(/<\/color>/gi, '')        // 去除 </color>
        .replace(/<[^>]*>/g, '')          // 去除任何 HTML/Unity 标签
        .replace(/\[[0-9a-fA-F]{6}\]/g, '')// 去除 [ff1a1a] 格式的十六进制颜色
        .replace(/\[\^[0-9]\]/g, '')       // 去除 [^1] 格式的 Quake 颜色
        .replace(/<#[\da-fA-F]+>/g, '')    // 去除 <#f450>
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // 去除不可见 Unicode 乱码
        .replace(/^["']|["']$/g, '')       // 去除两端多余引号
        .trim() || "Unknown";
}

function loadPlayers() {
    const csvPath = path.join(__dirname, 'steam_leaderboard_full.csv');
    if (!fs.existsSync(csvPath)) {
        console.warn("[WARN] 未找到 steam_leaderboard_full.csv 文件！");
        return [];
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);
    const players = [];
    const seenIds = new Set(); // 防止 CSV 内部有重复 SteamID

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length >= 5) {
            const steamId = parts[0].trim();
            // 立即清洗名字中的颜色标签
            const pureName = stripTags(parts[1]);
            const score = parseInt(parts[2], 10) || 1000;
            
            const wlPart = parts[4] || "0-0";
            const wlMatches = wlPart.split('-');
            const wins = parseInt(wlMatches[0], 10) || 0;
            const losses = parseInt(wlMatches[1], 10) || 0;
            const matches = wins + losses;

            // 过滤有效数字 SteamID 且去重
            if (steamId && /^\d+$/.test(steamId) && !seenIds.has(steamId)) {
                seenIds.add(steamId);
                players.push({
                    id: steamId,
                    name: pureName,
                    score: score,
                    wins: wins,
                    matches: matches
                });
            }
        }
    }
    return players;
}

module.exports = loadPlayers();
