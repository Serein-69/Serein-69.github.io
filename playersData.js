// playersData.js
const fs = require('fs');
const path = require('path');

function loadPlayers() {
    // 自动寻找 CSV 文件路径
    const csvPath = path.join(__dirname, 'steam_leaderboard_full.csv');
    if (!fs.existsSync(csvPath)) {
        console.warn("[WARN] 未找到 steam_leaderboard_full.csv 文件！");
        return [];
    }

    // 安全读取纯文本文件，彻底杜绝特殊符号导致的 JS 语法错误
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);
    const players = [];

    // 跳过第 0 行表头
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length >= 5) {
            const steamId = parts[0].trim();
            const name = parts[1].replace(/^["']|["']$/g, '').trim();
            const score = parseInt(parts[2], 10) || 1000;
            
            // 解析 W-L (如: 120-30)
            const wlPart = parts[4] || "0-0";
            const wlMatches = wlPart.split('-');
            const wins = parseInt(wlMatches[0], 10) || 0;
            const losses = parseInt(wlMatches[1], 10) || 0;
            const matches = wins + losses;

            // 过滤有效数字 ID
            if (steamId && /^\d+$/.test(steamId)) {
                players.push({
                    id: steamId,
                    name: name || "Unknown",
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