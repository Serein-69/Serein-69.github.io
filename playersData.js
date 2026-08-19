const fs = require('fs');
const path = require('path');

function loadPlayers() {

    const csvPath = path.join(__dirname, 'steam_leaderboard_full.csv');
    if (!fs.existsSync(csvPath)) {
        console.warn("[WARN] 未找到 steam_leaderboard_full.csv 文件！");
        return [];
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);
    const players = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length >= 5) {
            const steamId = parts[0].trim();
            const name = parts[1].replace(/^["']|["']$/g, '').trim();
            const score = parseInt(parts[2], 10) || 1000;
            
            const wlPart = parts[4] || "0-0";
            const wlMatches = wlPart.split('-');
            const wins = parseInt(wlMatches[0], 10) || 0;
            const losses = parseInt(wlMatches[1], 10) || 0;
            const matches = wins + losses;

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
