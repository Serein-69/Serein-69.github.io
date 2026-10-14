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
    ssl: { rejectUnauthorized: false }
});

const CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_REGEX = /^GEN-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123456';

// 过期卡密保留天数（超过这个天数自动清理）
const CLEANUP_KEEP_DAYS = 30;

// ==================== CORS ====================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ==================== 工具函数 ====================
function generateLicenseCode() {
    const part = (len) => {
        let res = '';
        for (let i = 0; i < len; i++) res += CHARSET.charAt(Math.floor(Math.random() * CHARSET.length));
        return res;
    };
    return 'GEN-' + part(4) + '-' + part(4) + '-' + part(4);
}

function cleanCode(s) {
    if (!s) return '';
    return String(s).trim().toUpperCase();
}

function cleanMachineId(s) {
    if (!s) return '';
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let m = 0;
    for (let i = 0; i < a.length; i++) m |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return m === 0;
}

// ==================== 初始化数据库 ====================
async function initDatabase() {
    try {
        const url = process.env.DATABASE_URL;
        console.log('[DB] 检查 DATABASE_URL...');
        if (!url) {
            console.error('[DB] 错误: DATABASE_URL 未配置');
            return;
        }
        console.log('[DB] DATABASE_URL 前缀:', url.substring(0, 25) + '...');
        console.log('[DB] 开始建表...');

        await pool.query(
            'CREATE TABLE IF NOT EXISTS licenses (' +
            'code VARCHAR(32) PRIMARY KEY, ' +
            'machine_id VARCHAR(64), ' +
            'duration_days INTEGER NOT NULL DEFAULT 30, ' +
            'bind_time BIGINT, ' +
            'expire_time BIGINT, ' +
            'last_verify_time BIGINT, ' +
            'is_banned INTEGER DEFAULT 0, ' +
            'remark VARCHAR(255), ' +
            'created_time BIGINT NOT NULL' +
            ')'
        );
        console.log('[DB] licenses 表已就绪');

        const r = await pool.query('SELECT COUNT(*) AS cnt FROM licenses');
        console.log('[DB] 当前卡密数量:', r.rows[0].cnt);
    } catch (e) {
        console.error('[DB] 初始化失败 - 消息:', e.message || '(空)');
        console.error('[DB] 初始化失败 - 代码:', e.code || '(无)');
    }
}

// ==================== 清理过期卡密 ====================
async function cleanupExpiredLicenses() {
    try {
        const now = Math.floor(Date.now() / 1000);
        const threshold = now - (CLEANUP_KEEP_DAYS * 86400);

        // 规则：
        // 1. 排除永久卡（duration_days >= 99999）
        // 2. 排除未绑定卡密（machine_id IS NULL），还没卖出去
        // 3. 排除未过期的
        // 4. 删除过期超过 CLEANUP_KEEP_DAYS 天的
        const r = await pool.query(
            'DELETE FROM licenses ' +
            'WHERE duration_days < 99999 ' +
            'AND machine_id IS NOT NULL ' +
            'AND expire_time > 0 ' +
            'AND expire_time < $1',
            [threshold]
        );

        if (r.rowCount > 0) {
            console.log('[清理] 删除', r.rowCount, '条过期超过', CLEANUP_KEEP_DAYS, '天的卡密');
        } else {
            console.log('[清理] 无过期卡密需要清理');
        }
        return r.rowCount;
    } catch (e) {
        console.error('[清理] 错误:', e.message);
        return 0;
    }
}

// ==================== 用户端 API ====================
app.post('/api/license/verify', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const machineId = cleanMachineId(req.body.machineId);
        const rawCode = cleanCode(req.body.code);

        if (!machineId && !rawCode) {
            return res.json({ status: 'error', message: '参数无效' });
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

        if (!lic) return res.json({ status: 'error', message: '设备未授权' });
        if (lic.is_banned === 1) return res.json({ status: 'error', message: '授权已被冻结' });

        const isPerm = lic.duration_days >= 99999;
        if (!isPerm && lic.expire_time && Number(lic.expire_time) < now) {
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/license/bind', async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const rawCode = cleanCode(req.body.code);
        const rawMachineId = cleanMachineId(req.body.machineId);

        if (!rawCode) return res.json({ status: 'error', message: '卡密代码不能为空' });
        if (!rawMachineId || rawMachineId.length < 8)
            return res.json({ status: 'error', message: '硬件特征码无效' });
        if (!CODE_REGEX.test(rawCode))
            return res.json({ status: 'error', message: '卡密格式不正确' });

        const r = await pool.query(
            "SELECT * FROM licenses WHERE code = $1 OR REPLACE(code,'-','') = REPLACE($1,'-','')",
            [rawCode]
        );
        const lic = r.rows[0];

        if (!lic) return res.json({ status: 'error', message: '卡密不存在' });
        if (lic.is_banned === 1) return res.json({ status: 'error', message: '卡密已被冻结' });

        if (lic.machine_id && cleanMachineId(lic.machine_id) !== rawMachineId) {
            return res.json({ status: 'error', message: '此卡密已绑定其他电脑，请联系管理员解绑' });
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
            status: 'success',
            code: lic.code,
            expireTime: expTime,
            daysLeft: daysLeft,
            message: isPerm ? '永久有效授权激活成功' : '激活成功，有效天数 ' + lic.duration_days + ' 天'
        });
    } catch (e) {
        console.error('[bind] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ==================== 管理员 API ====================
function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!timingSafeEqual(token, ADMIN_PASS))
        return res.status(401).json({ status: 'error', message: '管理员认证失败' });
    next();
}

app.get('/api/master-serein-8899/list', adminAuth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM licenses ORDER BY created_time DESC LIMIT 1000');
        res.json({ status: 'success', data: r.rows });
    } catch (e) {
        console.error('[admin/list] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/generate', adminAuth, async (req, res) => {
    try {
        const now = Math.floor(Date.now() / 1000);
        const count = Math.min(Math.max(1, parseInt(req.body.count || 1)), 100);
        const days = parseInt(req.body.days || 30);
        const remark = (req.body.remark || '').trim();
        const generated = [];

        for (let i = 0; i < count; i++) {
            const code = generateLicenseCode();
            await pool.query(
                'INSERT INTO licenses (code, duration_days, remark, created_time) VALUES ($1, $2, $3, $4)',
                [code, days, remark, now]
            );
            generated.push(code);
        }
        console.log('[admin/generate] 生成了', generated.length, '个卡密');
        res.json({ status: 'success', generated: generated });
    } catch (e) {
        console.error('[admin/generate] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/master-serein-8899/unbind', adminAuth, async (req, res) => {
    try {
        await pool.query(
            'UPDATE licenses SET machine_id = NULL, expire_time = 0, bind_time = 0 WHERE code = $1',
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

// ★ 手动触发清理
app.post('/api/master-serein-8899/cleanup', adminAuth, async (req, res) => {
    try {
        const deleted = await cleanupExpiredLicenses();
        res.json({ status: 'success', message: '已清理 ' + deleted + ' 条过期卡密', deleted: deleted });
    } catch (e) {
        console.error('[admin/cleanup] 错误:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ==================== 管理后台页面 ====================
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

// ==================== 健康检查 ====================
app.get('/', (req, res) => {
    res.send('Deskrawl License Server OK');
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (e) {
        console.error('[health] 错误:', e.message);
        res.status(500).json({ status: 'error', db: e.message });
    }
});

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log('[Server] 已启动，端口 ' + PORT);
    await initDatabase();

    // 启动时清理一次
    await cleanupExpiredLicenses();

    // 每小时自动清理一次
    setInterval(cleanupExpiredLicenses, 3600 * 1000);
    console.log('[清理] 定时任务已启动，每小时检查一次');
});
