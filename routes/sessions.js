// Sessions Routes - /api/sessions/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { generatePublicId } = require('../utils/publicId');
const { sanitizeString, sanitizeNumber } = require('../utils/validators');

router.use(authMiddleware);

// GET /api/sessions — user's sessions
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;
    const result = await db.query(`
      SELECT s.*, tp.name as plan_name, tp.icon as plan_icon, tp.color as plan_color
      FROM user_sessions s
      LEFT JOIN training_plans tp ON s.plan_id = tp.id
      WHERE s.user_id = $1
      ORDER BY s.session_date DESC, s.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, limit, offset]);
    const countResult = await db.query('SELECT COUNT(*) as total FROM user_sessions WHERE user_id = $1', [req.user.id]);
    res.json({ items: result.rows, total: parseInt(countResult.rows[0].total), limit, offset });
  } catch (error) {
    log.error('Get sessions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/sessions/stats — stats for charts
router.get('/stats', async (req, res) => {
  try {
    const monthly = await db.query(`
      SELECT date_trunc('month', session_date) as month, COUNT(*) as count,
        SUM(COALESCE(duration_seconds, duration_minutes * 60)) as total_seconds
      FROM user_sessions WHERE user_id = $1 AND session_date >= NOW() - INTERVAL '12 months'
      GROUP BY date_trunc('month', session_date) ORDER BY month
    `, [req.user.id]);
    const totals = await db.query(`
      SELECT COUNT(*) as total_sessions,
        SUM(COALESCE(duration_seconds, duration_minutes * 60)) as total_seconds,
        COUNT(DISTINCT session_date) as total_days, MAX(session_date) as last_session
      FROM user_sessions WHERE user_id = $1
    `, [req.user.id]);
    const byActivity = await db.query(`
      SELECT activity_type, COUNT(*) as count FROM user_sessions
      WHERE user_id = $1 GROUP BY activity_type ORDER BY count DESC
    `, [req.user.id]);
    res.json({ monthly: monthly.rows, totals: totals.rows[0], byActivity: byActivity.rows });
  } catch (error) {
    log.error('Get session stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sessions — log new session
router.post('/', async (req, res) => {
  try {
    const { plan_id, activity_type, duration_seconds, duration_minutes,
      park, notes, tricks_practiced, exercises_completed,
      exercises_total, session_date, session_type } = req.body;
    const validTypes = ['wakeboard', 'gym', 'run', 'swim', 'stretch'];
    const validSessionTypes = ['quick', 'plan', 'manual', 'past'];
    const actType = validTypes.includes(activity_type) ? activity_type : 'wakeboard';
    const sessType = validSessionTypes.includes(session_type) ? session_type : 'quick';
    const publicId = await generatePublicId('user_sessions', 'SES');
    const result = await db.query(`
      INSERT INTO user_sessions (
        public_id, user_id, plan_id, activity_type,
        duration_seconds, duration_minutes, park, notes,
        tricks_practiced, exercises_completed, exercises_total,
        session_date, session_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [
      publicId, req.user.id, plan_id || null, actType,
      sanitizeNumber(duration_seconds, 0, 86400) || null,
      sanitizeNumber(duration_minutes, 0, 1440) || null,
      sanitizeString(park, 200) || null,
      sanitizeString(notes, 2000) || null,
      tricks_practiced || null,
      exercises_completed ? JSON.stringify(exercises_completed) : null,
      sanitizeNumber(exercises_total, 0, 100) || null,
      session_date || new Date().toISOString().split('T')[0],
      sessType
    ]);
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Create session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/sessions/:id — delete own session
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM user_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (error) {
    log.error('Delete session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sessions/:id/share — share session to feed
router.post('/:id/share', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const userId = req.user.id;
    const { comment } = req.body;

    // Ensure table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS shared_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL,
        comment TEXT,
        shared_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, session_id)
      )
    `);

    // Get session to verify ownership
    const session = await db.query('SELECT * FROM user_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    await db.query(`
      INSERT INTO shared_sessions (user_id, session_id, comment)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, session_id)
      DO UPDATE SET comment = $3, shared_at = NOW()
    `, [userId, sessionId, sanitizeString(comment || '', 280) || null]);

    res.json({ success: true, shared: true });
  } catch (error) {
    log.error('Share session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
