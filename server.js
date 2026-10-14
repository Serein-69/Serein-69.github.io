import express from 'express';
import pg from 'pg';

const app = express();
app.use(express.json());

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_REGEX = /^GEN-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123456";

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function generateLicenseCode() {
    const part = (len) => {
        let res = "";
        for (let i = 0; i < len; i++) res += CHARSET.charAt(Math.floor(Math.random() * CHARSET.length));
        return res;
    };
    return `GEN-${part(4)}-${part(4)}-${part(4)}`;
}
const cleanCode = (s) => s ? String(s).trim().toUpperCase() : "";
const cleanMachineId = (s) => s ? String(s).replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase() : "";
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let m = 0;
    for (let i = 0; i < a.length; i++) m |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return m === 0;
}

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                code VARCHAR(32) PRIMARY KEY,
                machine_id VARCHAR(64),
                duration_days INTEGER NOT NULL DEFAULT 30,
                bind_time BIGINT,
                expire_time BIGINT,
                last_verify_time BIGINT,
                is_banned INTEGER DEFAULT 0,
                remark VARCHAR(255),
                created_time BIGINT NOT NULL
            )
        `);
        console.log('[DB] licenses 表已就绪');
    } catch (e) {
        console.error('[DB] 初始化失败:', e.message);
    }
}

// ==================== 用户端 API ====================
app.post('/api/license/verify', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const machineId = cleanMachineId(req.body.machineId);
        const rawCode = cleanCode(req.body.code);

        if (!machineId && !rawCode) {
            return res.json({ status: "error", message: "参数无效" });
        }

        let lic = null;
        if (machineId) {
            const r = await pool.query('SELECT * FROM licenses WHERE machine_id = $1', [machineId]);
            lic = r.rows[0];
        }
        if (!lic && rawCode) {
            const r = await pool.query(
                "SELECT * FROM licenses WHERE code = $1 OR REPLACE(code,'-','') = REPLACE($1,'-','')",
                [rawCode]
            );
            lic = r.rows[0];
        }

        if (!lic) return res.json({ status: "error", message: "设备未授权" });
        if (lic.is_banned === 1) return res.json({ status: "error", message: "授权已被冻结" });

        const isPerm = lic.duration_days >= 99999;
        if (!isPerm && lic.expire_time && Number(lic.expire_time) < now) {
            return res.json({ status: "error", message: "卡密已过期" });
        }

        await pool.query('UPDATE licenses SET last_verify_time = $1 WHERE code = $2', [now, lic.code]);

        const daysLeft = isPerm ? 99999 : Math.max(0, Math.ceil((Number(lic.expire_time) - now) / 86400));

        res.json({
            status: "success",
            code: lic.code,
            expireTime: Number(lic.expire_time) || 0,
            daysLeft,
            message: isPerm ? "永久有效" : `剩余 ${daysLeft} 天`
        });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.post('/api/license/bind', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const rawCode = cleanCode(req.body.code);
        const rawMachineId = cleanMachineId(req.body.machineId);

        if (!rawCode) return res.json({ status: "error", message: "卡密代码不能为空" });
        if (!rawMachineId || rawMachineId.length < 8)
            return res.json({ status: "error", message: "硬件特征码无效" });
        if (!CODE_REGEX.test(rawCode))
            return res.json({ status: "error", message: "卡密格式不正确" });

        const r = await pool.query(
            "SELECT * FROM licenses WHERE code = $1 OR REPLACE(code,'-','') = REPLACE($1,'-','')",
            [rawCode]
        );
        const lic = r.rows[0];

        if (!lic) return res.json({ status: "error", message: "卡密不存在" });
        if (lic.is_banned === 1) return res.json({ status: "error", message: "卡密已被冻结" });

        if (lic.machine_id && cleanMachineId(lic.machine_id) !== rawMachineId) {
            return res.json({ status: "error", message: "此卡密已绑定其他电脑，请联系管理员解绑" });
        }

        const isPerm = lic.duration_days >= 99999;
        let expTime = Number(lic.expire_time) || 0;

        if (!lic.machine_id) {
            expTime = isPerm ? 4102444800 : (now + (lic.duration_days * 86400));
            await pool.query(
                'UPDATE licenses SET machine_id = $1, bind_time = $2, expire_time = $3, last_verify_time = $4 WHERE code = $5',
                [rawMachineId, now, expTime, now, lic.code]
            );
        } else {
            await pool.query('UPDATE licenses SET last_verify_time = $1 WHERE code = $2', [now, lic.code]);
        }

        const daysLeft = isPerm ? 99999 : Math.max(0, Math.ceil((expTime - now) / 86400));

        res.json({
            status: "success",
            code: lic.code,
            expireTime: expTime,
            daysLeft,
            message: isPerm ? "永久有效授权激活成功" : `激活成功，有效天数 ${lic.duration_days} 天`
        });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!timingSafeEqual(token, ADMIN_PASS))
        return res.status(401).json({ status: "error", message: "管理员认证失败" });
    next();
}

app.get('/api/master-serein-8899/list', adminAuth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM licenses ORDER BY created_time DESC LIMIT 1000');
        res.json({ status: "success", data: r.rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.post('/api/master-serein-8899/generate', adminAuth, async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const count = Math.min(Math.max(1, parseInt(req.body.count || 1)), 100);
        const days = parseInt(req.body.days || 30);
        const remark = (req.body.remark || "").trim();
        const generated = [];

        for (let i = 0; i < count; i++) {
            const code = generateLicenseCode();
            await pool.query(
                'INSERT INTO licenses (code, duration_days, remark, created_time) VALUES ($1, $2, $3, $4)',
                [code, days, remark, now]
            );
            generated.push(code);
        }
        res.json({ status: "success", generated });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.post('/api/master-serein-8899/unbind', adminAuth, async (req, res) => {
    try {
        await pool.query('UPDATE licenses SET machine_id = NULL, expire_time = 0, bind_time = 0 WHERE code = $1', [cleanCode(req.body.code)]);
        res.json({ status: "success", message: "已解绑" });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.post('/api/master-serein-8899/delete', adminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM licenses WHERE code = $1', [cleanCode(req.body.code)]);
        res.json({ status: "success" });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.get('/master-control-serein-8899', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>卡密管理后台</title>
<style>
* { box-sizing: border-box; font-family: -apple-system, sans-serif; }
body { background: #090d16; color: #e2e8f0; margin: 0; padding: 24px; }
.wrap { max-width: 1200px; margin: 0 auto; }
h1 { color: #38bdf8; font-size: 22px; margin: 0 0 20px; }
.panel { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
input, select, button { padding: 9px 12px; border-radius: 4px; border: 1px solid #374151; background: #0c1322; color: #fff; margin-right: 8px; font-size: 13px; }
button { background: #2563eb; cursor: pointer; border: none; font-weight: 600; }
button:hover { background: #1d4ed8; }
button.green { background: #059669; }
button.green:hover { background: #047857; }
button.red { background: #dc2626; }
button.red:hover { background: #b91c1c; }
button.orange { background: #b45309; }
button.orange:hover { background: #92400e; }
table { width: 100%; border-collapse: collapse; margin-top: 15px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #1f2937; font-size: 13px; }
th { color: #94a3b8; }
.code-cell { font-family: monospace; color: #38bdf8; font-weight: 600; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
#log { color: #94a3b8; font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
<h1>Deskrawl 卡密管理后台</h1>

<div class="panel">
    <div class="row">
        <input type="password" id="pwd" placeholder="管理员密码" style="width: 220px;">
        <button onclick="savePwd()">保存密码</button>
        <button onclick="loadList()" class="green">刷新列表</button>
    </div>
    <div id="log">等待操作...</div>
</div>

<div class="panel">
    <h3 style="margin-top:0;color:#f8fafc;">批量生成卡密</h3>
    <div class="row">
        <input type="number" id="genCount" value="1" min="1" max="100" style="width:80px;" placeholder="数量">
        <select id="genDays">
            <option value="1">天卡 (1天)</option>
            <option value="7">周卡 (7天)</option>
            <option value="30" selected>月卡 (30天)</option>
            <option value="90">季卡 (90天)</option>
            <option value="365">年卡 (365天)</option>
            <option value="99999">永久卡</option>
        </select>
        <input type="text" id="genRemark" placeholder="备注（可选）" style="width:200px;">
        <button onclick="genCodes()" class="green">生成</button>
    </div>
</div>

<div class="panel">
    <h3 style="margin-top:0;color:#f8fafc;">卡密列表</h3>
    <table>
        <thead>
            <tr>
                <th>卡密</th>
                <th>时长</th>
                <th>机器码</th>
                <th>到期</th>
                <th>备注</th>
                <th>操作</th>
            </tr>
        </thead>
        <tbody id="list"></tbody>
    </table>
</div>
</div>

<script>
function getPwd() { return document.getElementById('pwd').value.trim(); }
function savePwd() { localStorage.setItem('deskrawl_admin_pwd', getPwd()); log('密码已保存'); }
function log(msg) { document.getElementById('log').innerText = '[' + new Date().toLocaleTimeString() + '] ' + msg; }

window.onload = () => {
    const saved = localStorage.getItem('deskrawl_admin_pwd');
    if (saved) { document.getElementById('pwd').value = saved; loadList(); }
};

async function loadList() {
    const pwd = getPwd();
    if (!pwd) return log('请先输入管理员密码');
    try {
        const r = await fetch('/api/master-serein-8899/list', {
            headers: { 'Authorization': 'Bearer ' + pwd }
        });
        const d = await r.json();
        if (d.status !== 'success') return log('认证失败：' + (d.message || ''));
        renderList(d.data);
        log('已加载 ' + d.data.length + ' 条卡密');
    } catch (e) { log('加载失败：' + e.message); }
}

function renderList(arr) {
    const tb = document.getElementById('list');
    if (!arr || arr.length === 0) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b;">暂无卡密，先生成一批</td></tr>'; return; }
    tb.innerHTML = '';
    arr.forEach(item => {
        const isPerm = item.duration_days >= 99999;
        const days = isPerm ? '<span style="color:#fbbf24;font-weight:600;">永久</span>' : item.duration_days + ' 天';
        const hwid = item.machine_id ? item.machine_id.substring(0, 20) + '...' : '<span style="color:#64748b;">未绑定</span>';
        const exp = isPerm ? '永久' : (item.expire_time ? new Date(Number(item.expire_time) * 1000).toLocaleString() : '<span style="color:#64748b;">未激活</span>');
        const tr = document.createElement('tr');
        tr.innerHTML = \`
            <td class="code-cell">\${item.code}</td>
            <td>\${days}</td>
            <td style="font-size:11px;">\${hwid}</td>
            <td style="font-size:12px;">\${exp}</td>
            <td>\${item.remark || '-'}</td>
            <td>
                \${item.machine_id ? '<button class="orange" onclick="unbind(\\'' + item.code + '\\')">解绑</button>' : ''}
                <button class="red" onclick="delCode(\\'' + item.code + '\\')">删除</button>
            </td>
        \`;
        tb.appendChild(tr);
    });
}

async function genCodes() {
    const pwd = getPwd();
    if (!pwd) return log('请先输入管理员密码');
    const count = document.getElementById('genCount').value;
    const days = document.getElementById('genDays').value;
    const remark = document.getElementById('genRemark').value;
    try {
        const r = await fetch('/api/master-serein-8899/generate', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + pwd, 'Content-Type': 'application/json' },
            body: JSON.stringify({ count, days, remark })
        });
        const d = await r.json();
        if (d.status !== 'success') return log('生成失败：' + d.message);
        log('成功生成 ' + d.generated.length + ' 个卡密：' + d.generated.join(', '));
        loadList();
    } catch (e) { log('生成失败：' + e.message); }
}

async function unbind(code) {
    if (!confirm('确认解绑 ' + code + '？')) return;
    const pwd = getPwd();
    await fetch('/api/master-serein-8899/unbind', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + pwd, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    log('已解绑 ' + code);
    loadList();
}

async function delCode(code) {
    if (!confirm('确认彻底删除 ' + code + '？')) return;
    const pwd = getPwd();
    await fetch('/api/master-serein-8899/delete', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + pwd, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    log('已删除 ' + code);
    loadList();
}
</script>
</body>
</html>`);
});

app.get('/', (req, res) => res.send('Deskrawl License Server OK'));
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (e) {
        res.status(500).json({ status: 'error', db: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(\`[Server] 已启动，端口 \${PORT}\`);
    await initDatabase();
});
