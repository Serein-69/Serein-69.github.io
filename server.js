import express from 'express';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5
});

const CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_REGEX = /^GEN-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123456';
const CLEANUP_KEEP_DAYS = 30;
const ONLINE_WINDOW = 600;
const RECENT_WINDOW = 3600;

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
        let res = '';
        for (let i = 0; i < len; i++) res += CHARSET.charAt(Math.floor(Math.random() * CHARSET.length));
        return res;
    };
    return 'GEN-' + part(4) + '-' + part(4) + '-' + part(4);
}

function cleanCode(s) { return s ? String(s).trim().toUpperCase() : ''; }
function cleanMachineId(s) { return s ? String(s).replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase() : ''; }
function cleanModule(s) {
    const m = s ? String(s).trim().toLowerCase() : 'assistant';
    return (m === 'violence') ? 'violence' : 'assistant';
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let m = 0;
    for (let i = 0; i < a.length; i++) m |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return m === 0;
}

async function withRetry(fn, label, maxAttempts = 5, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const isRetryable = (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.message === '');
            console.error(`[${label}] 第 ${attempt} 次失败:`, e.message || e.code || '(空)');
            if (!isRetryable || attempt === maxAttempts) throw e;
            console.log(`[${label}] ${delayMs}ms 后重试...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

function getTotalSeconds(durationDays, durationHours) {
    if (durationDays >= 99999) return -1;
    return (durationDays || 0) * 86400 + (durationHours || 0) * 3600;
}

async function initDatabase() {
    const url = process.env.DATABASE_URL;
    console.log('[DB] 检查 DATABASE_URL...');
    if (!url) { console.error('[DB] 错误: DATABASE_URL 未配置'); return; }
    console.log('[DB] DATABASE_URL 前缀:', url.substring(0, 25) + '...');
    console.log('[DB] 开始建表...');

    try {
        await withRetry(async () => {
            await pool.query(
                'CREATE TABLE IF NOT EXISTS licenses (' +
                'code VARCHAR(32) PRIMARY KEY, ' +
                'machine_id VARCHAR(64), ' +
                'duration_days INTEGER NOT NULL DEFAULT 30, ' +
                'duration_hours INTEGER DEFAULT 0, ' +
                'bind_time BIGINT, ' +
                'first_bind_time BIGINT DEFAULT 0, ' +
                'expire_time BIGINT, ' +
                'last_verify_time BIGINT, ' +
                'is_banned INTEGER DEFAULT 0, ' +
                'remark VARCHAR(255), ' +
                'module VARCHAR(20) DEFAULT \'assistant\', ' +
                'created_time BIGINT NOT NULL' +
                ')'
            );

            try { await pool.query("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS module VARCHAR(20) DEFAULT 'assistant'"); } catch (e) { }
            try { await pool.query("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS duration_hours INTEGER DEFAULT 0"); } catch (e) { }
            try { await pool.query("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS first_bind_time BIGINT DEFAULT 0"); } catch (e) { }

            await pool.query(
                'CREATE TABLE IF NOT EXISTS unauthorized_logs (' +
                'id SERIAL PRIMARY KEY, ' +
                'machine_id VARCHAR(64), ' +
                'code VARCHAR(32), ' +
                'reason VARCHAR(64), ' +
                'module VARCHAR(20) DEFAULT \'assistant\', ' +
                'attempt_time BIGINT NOT NULL' +
                ')'
            );

            try { await pool.query("ALTER TABLE unauthorized_logs ADD COLUMN IF NOT EXISTS module VARCHAR(20) DEFAULT 'assistant'"); } catch (e) { }
        }, 'DB', 5, 5000);

        console.log('[DB] licenses 表已就绪');
        console.log('[DB] unauthorized_logs 表已就绪');

        const r = await pool.query('SELECT COUNT(*) AS cnt FROM licenses');
        console.log('[DB] 当前卡密数量:', r.rows[0].cnt);

        const ra = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE module = 'assistant'");
        const rv = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE module = 'violence'");
        console.log('[DB] 助手版:', ra.rows[0].cnt, '暴力版:', rv.rows[0].cnt);
    } catch (e) {
        console.error('[DB] 初始化彻底失败:', e.message || e.code);
    }
}

async function cleanupExpiredLicenses() {
    try {
        const now = Math.floor(Date.now() / 1000);
        const threshold = now - (CLEANUP_KEEP_DAYS * 86400);

        const r = await pool.query(
            'DELETE FROM licenses ' +
            'WHERE duration_days < 99999 ' +
            'AND machine_id IS NOT NULL ' +
            'AND expire_time > 0 ' +
            'AND expire_time < $1',
            [threshold]
        );

        const r2 = await pool.query(
            'DELETE FROM unauthorized_logs WHERE attempt_time < $1',
            [now - (7 * 86400)]
        );

        if (r.rowCount > 0) console.log('[清理] 删除', r.rowCount, '条过期卡密');
        if (r2.rowCount > 0) console.log('[清理] 删除', r2.rowCount, '条未授权记录');
    } catch (e) {
        console.error('[清理] 错误:', e.message || e.code);
    }
}

async function logUnauthorized(machineId, code, reason, module) {
    try {
        const now = Math.floor(Date.now() / 1000);
        await pool.query(
            'INSERT INTO unauthorized_logs (machine_id, code, reason, module, attempt_time) VALUES ($1, $2, $3, $4, $5)',
            [machineId || '', code || '', reason, module || 'assistant', now]
        );
    } catch (e) { console.error('[unauth-log] 错误:', e.message); }
}

app.post('/api/license/verify', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const machineId = cleanMachineId(req.body.machineId);
        const rawCode = cleanCode(req.body.code);
        const module = cleanModule(req.body.module);

        if (!machineId && !rawCode) return res.json({ status: 'error', message: '参数无效' });

        let lic = null;
        if (machineId) {
            const r = await pool.query('SELECT * FROM licenses WHERE machine_id = $1 AND module = $2', [machineId, module]);
            lic = r.rows[0];
        }
        if (!lic && rawCode) {
            const r = await pool.query(
                "SELECT * FROM licenses WHERE (code = $1 OR REPLACE(code,'-','') = REPLACE($1,'-','')) AND module = $2",
                [rawCode, module]
            );
            lic = r.rows[0];
        }

        if (!lic) { await logUnauthorized(machineId, rawCode, 'not_found', module); return res.json({ status: 'error', message: '设备未授权' }); }
        if (lic.is_banned === 1) { await logUnauthorized(machineId, lic.code, 'banned', module); return res.json({ status: 'error', message: '授权已被冻结' }); }

        const isPerm = lic.duration_days >= 99999;
        if (!isPerm && lic.expire_time && Number(lic.expire_time) < now) {
            await logUnauthorized(machineId, lic.code, 'expired', module);
            return res.json({ status: 'error', message: '卡密已过期' });
        }

        await pool.query('UPDATE licenses SET last_verify_time = $1 WHERE code = $2', [now, lic.code]);

        const daysLeft = isPerm ? 99999 : Math.max(0, Math.ceil((Number(lic.expire_time) - now) / 86400));

        res.json({
            status: 'success',
            code: lic.code,
            expireTime: Number(lic.expire_time) || 0,
            daysLeft: daysLeft,
            message: isPerm ? '永久有效' : '剩余 ' + daysLeft + ' 天'
        });
    } catch (e) {
        console.error('[verify] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message || 'DB 错误' });
    }
});

app.post('/api/license/bind', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const rawCode = cleanCode(req.body.code);
        const rawMachineId = cleanMachineId(req.body.machineId);
        const module = cleanModule(req.body.module);

        if (!rawCode) return res.json({ status: 'error', message: '卡密代码不能为空' });
        if (!rawMachineId || rawMachineId.length < 8) return res.json({ status: 'error', message: '硬件特征码无效' });
        if (!CODE_REGEX.test(rawCode)) return res.json({ status: 'error', message: '卡密格式不正确' });

        const r = await pool.query(
            "SELECT * FROM licenses WHERE (code = $1 OR REPLACE(code,'-','') = REPLACE($1,'-','')) AND module = $2",
            [rawCode, module]
        );
        const lic = r.rows[0];

        if (!lic) { await logUnauthorized(rawMachineId, rawCode, 'bind_not_found', module); return res.json({ status: 'error', message: '卡密不存在或与当前模块不匹配' }); }
        if (lic.is_banned === 1) { await logUnauthorized(rawMachineId, lic.code, 'bind_banned', module); return res.json({ status: 'error', message: '卡密已被冻结' }); }

        if (lic.machine_id && cleanMachineId(lic.machine_id) !== rawMachineId) {
            await logUnauthorized(rawMachineId, lic.code, 'bind_other_machine', module);
            return res.json({ status: 'error', message: '此卡密已绑定其他电脑，请联系管理员解绑' });
        }

        const isPerm = lic.duration_days >= 99999;
        let expTime = Number(lic.expire_time) || 0;
        let firstBind = Number(lic.first_bind_time) || 0;

        if (!lic.machine_id) {
            if (firstBind <= 0) {
                firstBind = now;
            }
            if (isPerm) {
                expTime = 4102444800;
            } else {
                const totalSec = getTotalSeconds(lic.duration_days, lic.duration_hours);
                expTime = firstBind + totalSec;
            }

            await pool.query(
                'UPDATE licenses SET machine_id = $1, bind_time = $2, first_bind_time = $3, expire_time = $4, last_verify_time = $5 WHERE code = $6',
                [rawMachineId, now, firstBind, expTime, now, lic.code]
            );
        } else {
            await pool.query('UPDATE licenses SET last_verify_time = $1 WHERE code = $2', [now, lic.code]);
        }

        if (!isPerm && expTime < now) {
            return res.json({ status: 'error', message: '卡密已过期' });
        }

        const daysLeft = isPerm ? 99999 : Math.max(0, Math.ceil((expTime - now) / 86400));

        res.json({
            status: 'success',
            code: lic.code,
            expireTime: expTime,
            daysLeft: daysLeft,
            message: isPerm ? '永久有效授权激活成功' : '激活成功，剩余 ' + daysLeft + ' 天'
        });
    } catch (e) {
        console.error('[bind] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message || 'DB 错误' });
    }
});

function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!timingSafeEqual(token, ADMIN_PASS))
        return res.status(401).json({ status: 'error', message: '管理员认证失败' });
    next();
}

app.get('/api/master-serein-8899/list', adminAuth, async (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        const module = (req.query.module || '').trim();

        let sql = 'SELECT * FROM licenses WHERE 1=1';
        const params = [];
        let idx = 1;

        if (search) {
            sql += ' AND (code ILIKE $' + idx + ' OR remark ILIKE $' + idx + ' OR machine_id ILIKE $' + idx + ')';
            params.push('%' + search + '%');
            idx++;
        }
        if (module) {
            sql += ' AND module = $' + idx;
            params.push(module);
            idx++;
        }

        sql += ' ORDER BY created_time DESC LIMIT 1000';

        const r = await pool.query(sql, params);
        res.json({ status: 'success', data: r.rows });
    } catch (e) {
        console.error('[admin/list] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.get('/api/master-serein-8899/online', adminAuth, async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const onlineThreshold = now - ONLINE_WINDOW;
        const recentThreshold = now - RECENT_WINDOW;

        const onlineResult = await pool.query(
            'SELECT code, machine_id, remark, last_verify_time, duration_days, expire_time, module ' +
            'FROM licenses WHERE last_verify_time >= $1 ORDER BY last_verify_time DESC',
            [onlineThreshold]
        );
        const recentResult = await pool.query('SELECT COUNT(*) AS cnt FROM licenses WHERE last_verify_time >= $1', [recentThreshold]);
        const totalBoundResult = await pool.query('SELECT COUNT(*) AS cnt FROM licenses WHERE machine_id IS NOT NULL');
        const totalResult = await pool.query('SELECT COUNT(*) AS cnt FROM licenses');
        const totalAssistant = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE module = 'assistant'");
        const totalViolence = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE module = 'violence'");
        const onlineAssistant = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE last_verify_time >= $1 AND module = 'assistant'", [onlineThreshold]);
        const onlineViolence = await pool.query("SELECT COUNT(*) AS cnt FROM licenses WHERE last_verify_time >= $1 AND module = 'violence'", [onlineThreshold]);
        const unauthResult = await pool.query(
            'SELECT machine_id, code, reason, module, attempt_time FROM unauthorized_logs WHERE attempt_time >= $1 ORDER BY attempt_time DESC LIMIT 50',
            [recentThreshold]
        );

        res.json({
            status: 'success',
            online_count: onlineResult.rows.length,
            online_list: onlineResult.rows,
            recent_count: parseInt(recentResult.rows[0].cnt),
            total_bound: parseInt(totalBoundResult.rows[0].cnt),
            total: parseInt(totalResult.rows[0].cnt),
            total_assistant: parseInt(totalAssistant.rows[0].cnt),
            total_violence: parseInt(totalViolence.rows[0].cnt),
            online_assistant: parseInt(onlineAssistant.rows[0].cnt),
            online_violence: parseInt(onlineViolence.rows[0].cnt),
            unauthorized_list: unauthResult.rows
        });
    } catch (e) {
        console.error('[admin/online] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/generate', adminAuth, async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const count = Math.min(Math.max(1, parseInt(req.body.count || 1)), 100);
        const duration = String(req.body.duration || '30').trim();
        const remark = (req.body.remark || '').trim();
        const module = cleanModule(req.body.module);
        const generated = [];

        let durationDays = 30, durationHours = 0;
        if (duration.startsWith('h')) {
            durationHours = parseInt(duration.substring(1)) || 1;
            durationDays = 0;
        } else {
            durationDays = parseInt(duration) || 30;
            durationHours = 0;
        }

        for (let i = 0; i < count; i++) {
            const code = generateLicenseCode();
            await pool.query(
                'INSERT INTO licenses (code, duration_days, duration_hours, remark, module, created_time) VALUES ($1, $2, $3, $4, $5, $6)',
                [code, durationDays, durationHours, remark, module, now]
            );
            generated.push(code);
        }
        console.log('[admin/generate] 生成', generated.length, '个卡密, module=', module, '时长:', durationDays + '天' + durationHours + '小时');
        res.json({ status: 'success', generated: generated });
    } catch (e) {
        console.error('[admin/generate] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/extend', adminAuth, async (req, res) => {
    try {
        const days = parseInt(req.body.days || 0);
        const codes = req.body.codes || [];
        if (days === 0) return res.json({ status: 'error', message: '延期天数不能为 0' });

        let result;
        if (codes.length === 0) {
            result = await pool.query(
                'UPDATE licenses SET ' +
                'first_bind_time = CASE WHEN first_bind_time > 0 THEN first_bind_time ELSE 0 END, ' +
                'expire_time = CASE WHEN duration_days >= 99999 THEN 4102444800 ELSE COALESCE(expire_time, 0) + $1 END ' +
                'WHERE duration_days < 99999',
                [days * 86400]
            );
        } else {
            const placeholders = codes.map((_, i) => '$' + (i + 2)).join(',');
            result = await pool.query(
                'UPDATE licenses SET expire_time = CASE WHEN duration_days >= 99999 THEN 4102444800 ELSE COALESCE(expire_time, 0) + $1 END ' +
                'WHERE code IN (' + placeholders + ') AND duration_days < 99999',
                [days * 86400].concat(codes)
            );
        }

        res.json({ status: 'success', message: '已延期 ' + result.rowCount + ' 张卡密（+' + days + '天）', affected: result.rowCount });
    } catch (e) {
        console.error('[admin/extend] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/batch-unbind', adminAuth, async (req, res) => {
    try {
        const codes = req.body.codes || [];
        if (codes.length === 0) return res.json({ status: 'error', message: '未选择卡密' });
        const placeholders = codes.map((_, i) => '$' + (i + 1)).join(',');
        const result = await pool.query(
            'UPDATE licenses SET machine_id = NULL, expire_time = 0, bind_time = 0, first_bind_time = 0 WHERE code IN (' + placeholders + ')',
            codes
        );
        res.json({ status: 'success', message: '已解绑 ' + result.rowCount + ' 张卡密', affected: result.rowCount });
    } catch (e) {
        console.error('[admin/batch-unbind] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/batch-delete', adminAuth, async (req, res) => {
    try {
        const codes = req.body.codes || [];
        if (codes.length === 0) return res.json({ status: 'error', message: '未选择卡密' });
        const placeholders = codes.map((_, i) => '$' + (i + 1)).join(',');
        const result = await pool.query('DELETE FROM licenses WHERE code IN (' + placeholders + ')', codes);
        res.json({ status: 'success', message: '已删除 ' + result.rowCount + ' 张卡密', affected: result.rowCount });
    } catch (e) {
        console.error('[admin/batch-delete] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/unbind', adminAuth, async (req, res) => {
    try {
        await pool.query(
            'UPDATE licenses SET machine_id = NULL, expire_time = 0, bind_time = 0, first_bind_time = 0 WHERE code = $1',
            [cleanCode(req.body.code)]
        );
        res.json({ status: 'success', message: '已解绑' });
    } catch (e) {
        console.error('[admin/unbind] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/delete', adminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM licenses WHERE code = $1', [cleanCode(req.body.code)]);
        res.json({ status: 'success' });
    } catch (e) {
        console.error('[admin/delete] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/ban', adminAuth, async (req, res) => {
    try {
        const code = cleanCode(req.body.code);
        const banned = req.body.banned ? 1 : 0;
        await pool.query('UPDATE licenses SET is_banned = $1 WHERE code = $2', [banned, code]);
        res.json({ status: 'success', message: banned ? '已冻结' : '已解冻' });
    } catch (e) {
        console.error('[admin/ban] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/cleanup', adminAuth, async (req, res) => {
    try {
        await cleanupExpiredLicenses();
        res.json({ status: 'success', message: '已清理过期卡密' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.get('/master-control-serein-8899', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'admin.html');
        const html = fs.readFileSync(filePath, 'utf-8');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        console.error('[admin page] 错误:', e.message);
        res.status(500).send('admin.html 读取失败: ' + e.message);
    }
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
    console.log('[Server] 已启动，端口 ' + PORT);
    await new Promise(r => setTimeout(r, 2000));
    await initDatabase();
    await cleanupExpiredLicenses();
    setInterval(cleanupExpiredLicenses, 3600 * 1000);
    console.log('[清理] 定时任务已启动，每小时检查一次');
});
