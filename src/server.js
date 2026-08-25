require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { z } = require('zod');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'chat-buzz-development-secret-change-me';
const isProduction = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;

if (isProduction && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required in production.');
  process.exit(1);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.PGSSL === 'true' || DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
    })
  : null;

let databaseReady = false;

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
    ? process.env.CORS_ORIGIN.split(',').map((value) => value.trim())
    : '*',
  credentials: process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*' ? true : false,
}));
app.use(express.json({ limit: '1mb' }));

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    bio: user.bio,
    points: Number(user.points || 0),
    createdAt: user.created_at,
  };
}

function createToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authRequired(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'unauthorized', message: 'يلزم تسجيل الدخول.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!pool || !databaseReady) {
      return res.status(503).json({ ok: false, error: 'database_unavailable', message: 'قاعدة البيانات غير جاهزة.' });
    }
    const result = await pool.query(
      'SELECT id, username, display_name, avatar_url, bio, points, created_at FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!result.rows[0]) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'جلسة المستخدم غير صالحة.' });
    }
    req.user = result.rows[0];
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: 'invalid_token', message: 'رمز الدخول غير صالح أو منتهي.' });
  }
}

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'validation_error',
        message: 'تحقق من البيانات المرسلة.',
        details: parsed.error.flatten(),
      });
    }
    req[source] = parsed.data;
    next();
  };
}

function normalizeUsername(value) {
  return value.trim().toLowerCase();
}

const registerSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, 'استخدم الحروف الإنجليزية والأرقام والشرطة السفلية فقط.'),
  displayName: z.string().trim().min(2).max(80),
  password: z.string().min(6).max(128),
});

const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
});

const createRoomSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional().nullable(),
  category: z.string().trim().min(2).max(40).default('عام'),
  coverUrl: z.string().url().max(1000).optional().nullable(),
  maxMembers: z.number().int().min(2).max(10000).default(100),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

const sendGiftSchema = z.object({
  giftId: z.string().uuid(),
  recipientId: z.string().uuid(),
  roomId: z.string().uuid().optional().nullable(),
  quantity: z.number().int().min(1).max(100).default(1),
});

async function isRoomMember(roomId, userId) {
  const result = await pool.query(
    'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return result.rows[0] || null;
}

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is not set; API will start in degraded mode.');
    return;
  }
  try {
    const schemaPath = path.join(__dirname, '..', 'drizzle', 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');
    await pool.query(schema);
    databaseReady = true;
    console.log('PostgreSQL schema is ready.');
  } catch (error) {
    databaseReady = false;
    console.error('PostgreSQL initialization failed:', error.message);
  }
}

app.get('/health', async (req, res) => {
  let database = 'not_configured';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      database = databaseReady ? 'ready' : 'connected';
    } catch (error) {
      database = 'error';
    }
  }
  const healthy = database === 'ready';
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'chat-buzz-api',
    version: '1.0.0',
    database,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1', (req, res) => {
  res.json({
    ok: true,
    name: 'Chat Buzz API',
    version: 'v1',
    endpoints: {
      health: '/health',
      auth: '/api/v1/auth/register, /api/v1/auth/login, /api/v1/me',
      rooms: '/api/v1/rooms',
      messages: '/api/v1/rooms/:roomId/messages',
      gifts: '/api/v1/gifts, /api/v1/gifts/send',
    },
  });
});

app.post('/api/v1/auth/register', validate(registerSchema), async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, display_name, avatar_url, bio, points, created_at`,
      [username, req.body.displayName, passwordHash],
    );
    const user = result.rows[0];
    res.status(201).json({ ok: true, user: publicUser(user), token: createToken(user) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, error: 'username_taken', message: 'اسم المستخدم مستخدم مسبقاً.' });
    }
    next(error);
  }
});

app.post('/api/v1/auth/login', validate(loginSchema), async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, bio, points, created_at, password_hash
       FROM users WHERE username = $1`,
      [username],
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }
    res.json({ ok: true, user: publicUser(user), token: createToken(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/me', authRequired, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.get('/api/v1/users/search', authRequired, async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ ok: true, users: [] });
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, bio, points, created_at
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY display_name ASC LIMIT 20`,
      [`%${query}%`],
    );
    res.json({ ok: true, users: result.rows.map(publicUser) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/rooms', async (req, res, next) => {
  try {
    const category = req.query.category ? String(req.query.category) : null;
    const result = await pool.query(
      `SELECT r.id, r.name, r.description, r.category, r.cover_url, r.is_live,
              r.max_members, r.created_at, r.owner_id,
              u.username AS owner_username, u.display_name AS owner_display_name,
              COUNT(rm.user_id)::int AS member_count
       FROM rooms r
       JOIN users u ON u.id = r.owner_id
       LEFT JOIN room_members rm ON rm.room_id = r.id
       WHERE r.is_live = TRUE AND ($1::text IS NULL OR r.category = $1)
       GROUP BY r.id, u.username, u.display_name
       ORDER BY r.created_at DESC LIMIT 100`,
      [category],
    );
    res.json({ ok: true, rooms: result.rows.map((room) => ({
      id: room.id,
      name: room.name,
      description: room.description,
      category: room.category,
      coverUrl: room.cover_url,
      isLive: room.is_live,
      maxMembers: room.max_members,
      memberCount: room.member_count,
      owner: { id: room.owner_id, username: room.owner_username, displayName: room.owner_display_name },
      createdAt: room.created_at,
    })) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/rooms', authRequired, validate(createRoomSchema), async (req, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const roomResult = await client.query(
        `INSERT INTO rooms (owner_id, name, description, category, cover_url, max_members)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, category, cover_url, is_live, max_members, created_at`,
        [req.user.id, req.body.name, req.body.description || null, req.body.category, req.body.coverUrl || null, req.body.maxMembers],
      );
      const room = roomResult.rows[0];
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [room.id, req.user.id],
      );
      await client.query('COMMIT');
      res.status(201).json({ ok: true, room: { ...room, coverUrl: room.cover_url, isLive: room.is_live, maxMembers: room.max_members, memberCount: 1 } });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/rooms/:roomId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.description, r.category, r.cover_url, r.is_live,
              r.max_members, r.created_at, r.owner_id,
              u.username AS owner_username, u.display_name AS owner_display_name
       FROM rooms r JOIN users u ON u.id = r.owner_id WHERE r.id = $1`,
      [req.params.roomId],
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: 'room_not_found', message: 'الغرفة غير موجودة.' });
    const room = result.rows[0];
    const members = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, rm.role, rm.joined_at
       FROM room_members rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1 ORDER BY rm.joined_at ASC LIMIT 200`,
      [req.params.roomId],
    );
    res.json({ ok: true, room: {
      id: room.id,
      name: room.name,
      description: room.description,
      category: room.category,
      coverUrl: room.cover_url,
      isLive: room.is_live,
      maxMembers: room.max_members,
      owner: { id: room.owner_id, username: room.owner_username, displayName: room.owner_display_name },
      members: members.rows.map((member) => ({
        id: member.id,
        username: member.username,
        displayName: member.display_name,
        avatarUrl: member.avatar_url,
        role: member.role,
        joinedAt: member.joined_at,
      })),
      createdAt: room.created_at,
    } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/rooms/:roomId/join', authRequired, async (req, res, next) => {
  try {
    const roomResult = await pool.query('SELECT id, max_members, is_live FROM rooms WHERE id = $1', [req.params.roomId]);
    const room = roomResult.rows[0];
    if (!room) return res.status(404).json({ ok: false, error: 'room_not_found', message: 'الغرفة غير موجودة.' });
    if (!room.is_live) return res.status(409).json({ ok: false, error: 'room_closed', message: 'الغرفة مغلقة حالياً.' });
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1', [room.id]);
    const alreadyMember = await isRoomMember(room.id, req.user.id);
    if (!alreadyMember && countResult.rows[0].count >= room.max_members) {
      return res.status(409).json({ ok: false, error: 'room_full', message: 'الغرفة ممتلئة.' });
    }
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'listener')
       ON CONFLICT (room_id, user_id) DO UPDATE SET joined_at = NOW()`,
      [room.id, req.user.id],
    );
    res.json({ ok: true, roomId: room.id, role: alreadyMember?.role || 'listener' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/rooms/:roomId/leave', authRequired, async (req, res, next) => {
  try {
    const room = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.roomId]);
    if (!room.rows[0]) return res.status(404).json({ ok: false, error: 'room_not_found', message: 'الغرفة غير موجودة.' });
    if (room.rows[0].owner_id === req.user.id) {
      return res.status(409).json({ ok: false, error: 'owner_cannot_leave', message: 'مالك الغرفة لا يغادرها؛ أغلقها أو سلّم الملكية أولاً.' });
    }
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.roomId, req.user.id]);
    res.json({ ok: true, roomId: req.params.roomId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/rooms/:roomId/messages', authRequired, async (req, res, next) => {
  try {
    const member = await isRoomMember(req.params.roomId, req.user.id);
    if (!member) return res.status(403).json({ ok: false, error: 'not_a_member', message: 'انضم إلى الغرفة أولاً.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const result = await pool.query(
      `SELECT m.id, m.body, m.created_at, u.id AS sender_id, u.username, u.display_name, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [req.params.roomId, limit],
    );
    res.json({ ok: true, messages: result.rows.reverse().map((message) => ({
      id: message.id,
      body: message.body,
      createdAt: message.created_at,
      sender: { id: message.sender_id, username: message.username, displayName: message.display_name, avatarUrl: message.avatar_url },
    })) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/rooms/:roomId/messages', authRequired, validate(messageSchema), async (req, res, next) => {
  try {
    const member = await isRoomMember(req.params.roomId, req.user.id);
    if (!member) return res.status(403).json({ ok: false, error: 'not_a_member', message: 'انضم إلى الغرفة أولاً.' });
    const result = await pool.query(
      `INSERT INTO messages (room_id, sender_id, body) VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [req.params.roomId, req.user.id, req.body.body],
    );
    const message = result.rows[0];
    res.status(201).json({ ok: true, message: {
      id: message.id,
      body: message.body,
      createdAt: message.created_at,
      sender: publicUser(req.user),
    } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/gifts', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name, emoji, image_url, price FROM gifts WHERE active = TRUE ORDER BY price ASC`,
    );
    res.json({ ok: true, gifts: result.rows.map((gift) => ({
      id: gift.id,
      code: gift.code,
      name: gift.name,
      emoji: gift.emoji,
      imageUrl: gift.image_url,
      price: Number(gift.price),
    })) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/gifts/send', authRequired, validate(sendGiftSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const giftResult = await client.query(
      'SELECT id, code, name, emoji, image_url, price FROM gifts WHERE id = $1 AND active = TRUE FOR UPDATE',
      [req.body.giftId],
    );
    const gift = giftResult.rows[0];
    if (!gift) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'gift_not_found', message: 'الهدية غير موجودة.' });
    }
    const recipientResult = await client.query('SELECT id, username, display_name, avatar_url FROM users WHERE id = $1', [req.body.recipientId]);
    if (!recipientResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'recipient_not_found', message: 'المستقبل غير موجود.' });
    }
    if (req.body.roomId) {
      const roomMemberResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1 AND user_id IN ($2, $3)`,
        [req.body.roomId, req.user.id, req.body.recipientId],
      );
      if (roomMemberResult.rows[0].count < 2) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, error: 'room_membership_required', message: 'يجب أن يكون المرسل والمستقبل داخل الغرفة.' });
      }
    }
    const senderResult = await client.query('SELECT id, points FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const total = Number(gift.price) * req.body.quantity;
    const balance = Number(senderResult.rows[0].points);
    if (balance < total) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'insufficient_points', message: 'رصيد النقاط غير كافٍ.', balance, required: total });
    }
    const transactionResult = await client.query(
      `INSERT INTO gift_transactions (gift_id, sender_id, recipient_id, room_id, quantity, total_points)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [gift.id, req.user.id, req.body.recipientId, req.body.roomId || null, req.body.quantity, total],
    );
    await client.query('UPDATE users SET points = points - $1, updated_at = NOW() WHERE id = $2', [total, req.user.id]);
    await client.query('UPDATE users SET points = points + $1, updated_at = NOW() WHERE id = $2', [total, req.body.recipientId]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, transaction: {
      id: transactionResult.rows[0].id,
      gift: { id: gift.id, code: gift.code, name: gift.name, emoji: gift.emoji, imageUrl: gift.image_url, price: Number(gift.price) },
      sender: publicUser(req.user),
      recipient: publicUser(recipientResult.rows[0]),
      roomId: req.body.roomId || null,
      quantity: req.body.quantity,
      totalPoints: total,
      createdAt: transactionResult.rows[0].created_at,
      remainingPoints: balance - total,
    } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/v1/gifts/history', authRequired, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT gt.id, gt.quantity, gt.total_points, gt.room_id, gt.created_at,
              g.code, g.name, g.emoji, g.image_url,
              su.id AS sender_id, su.username AS sender_username, su.display_name AS sender_display_name,
              ru.id AS recipient_id, ru.username AS recipient_username, ru.display_name AS recipient_display_name
       FROM gift_transactions gt
       JOIN gifts g ON g.id = gt.gift_id
       JOIN users su ON su.id = gt.sender_id
       JOIN users ru ON ru.id = gt.recipient_id
       WHERE gt.sender_id = $1 OR gt.recipient_id = $1
       ORDER BY gt.created_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.json({ ok: true, transactions: result.rows.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      totalPoints: Number(item.total_points),
      roomId: item.room_id,
      gift: { code: item.code, name: item.name, emoji: item.emoji, imageUrl: item.image_url },
      sender: { id: item.sender_id, username: item.sender_username, displayName: item.sender_display_name },
      recipient: { id: item.recipient_id, username: item.recipient_username, displayName: item.recipient_display_name },
      createdAt: item.created_at,
    })) });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', message: 'المسار غير موجود.' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled API error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ ok: false, error: 'internal_error', message: 'حدث خطأ داخلي في الخادم.' });
});

async function start() {
  await initializeDatabase();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat Buzz API listening on port ${PORT}`);
  });
  const shutdown = async (signal) => {
    console.log(`${signal} received; shutting down.`);
    server.close(async () => {
      if (pool) await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.env.SKIP_LISTEN !== 'true') {
  start();
}

module.exports = { app, createToken, publicUser };
