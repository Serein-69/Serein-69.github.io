const fs = require('fs');
const path = require('path');

function stripTags(str) {
    if (!str) return "Unknown";
    return String(str)
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

function loadPlayers() {
    const csvPath = path.join(__dirname, 'steam_leaderboard_full.csv');
    if (!fs.existsSync(csvPath)) {
        console.warn("[WARN] 未找到 steam_leaderboard_full.csv 文件！");
        return [];
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);
    const players = [];
    const seenIds = new Set();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length >= 5) {
            const steamId = parts[0].trim();

            const pureName = stripTags(parts[1]);
            const score = parseInt(parts[2], 10) || 1000;
            
            const wlPart = parts[4] || "0-0";
            const wlMatches = wlPart.split('-');
            const wins = parseInt(wlMatches[0], 10) || 0;
            const losses = parseInt(wlMatches[1], 10) || 0;
            const matches = wins + losses;

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
