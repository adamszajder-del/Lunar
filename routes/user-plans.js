// User Training Plans Routes - /api/user-plans/*
// Custom training plans created by users
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');

router.use(authMiddleware);

// Ensure table exists on first load
db.query(`
  CREATE TABLE IF NOT EXISTS user_training_plans (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(10) DEFAULT '🎯',
    items JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    use_count INTEGER DEFAULT 0
  )
`).catch(() => {});

// GET /api/user-plans — all plans for current user, sorted by last_used
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM user_training_plans
      WHERE user_id = $1
      ORDER BY last_used_at DESC NULLS LAST, created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    log.error('Get user plans error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/user-plans — create new plan
router.post('/', async (req, res) => {
  try {
    const { name, icon, items } = req.body;
    const safeName = sanitizeString(name, 100);
    if (!safeName) return res.status(400).json({ error: 'Plan name is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });
    if (items.length > 30) return res.status(400).json({ error: 'Max 30 items per plan' });

    // Validate items shape
    const safeItems = items.map(item => {
      if (item.type === 'trick') return { type: 'trick', trick_id: parseInt(item.trick_id), note: sanitizeString(item.note || '', 200) || '' };
      if (item.type === 'custom') return { type: 'custom', text: sanitizeString(item.text || '', 200) || 'Exercise' };
      return null;
    }).filter(Boolean);

    const result = await db.query(`
      INSERT INTO user_training_plans (user_id, name, icon, items)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.user.id, safeName, icon || '🎯', JSON.stringify(safeItems)]);

    res.json(result.rows[0]);
  } catch (error) {
    log.error('Create user plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/user-plans/:id — update plan
router.put('/:id', async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    const { name, icon, items } = req.body;
    const safeName = sanitizeString(name, 100);
    if (!safeName) return res.status(400).json({ error: 'Plan name is required' });

    const safeItems = (items || []).map(item => {
      if (item.type === 'trick') return { type: 'trick', trick_id: parseInt(item.trick_id), note: sanitizeString(item.note || '', 200) || '' };
      if (item.type === 'custom') return { type: 'custom', text: sanitizeString(item.text || '', 200) || 'Exercise' };
      return null;
    }).filter(Boolean);

    const result = await db.query(`
      UPDATE user_training_plans
      SET name = $1, icon = $2, items = $3, updated_at = NOW()
      WHERE id = $4 AND user_id = $5
      RETURNING *
    `, [safeName, icon || '🎯', JSON.stringify(safeItems), planId, req.user.id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Update user plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/user-plans/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM user_training_plans WHERE id = $1 AND user_id = $2 RETURNING id',
      [parseInt(req.params.id), req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    res.json({ success: true });
  } catch (error) {
    log.error('Delete user plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/user-plans/:id/use — mark plan as used (updates last_used_at + use_count)
router.post('/:id/use', async (req, res) => {
  try {
    await db.query(`
      UPDATE user_training_plans
      SET last_used_at = NOW(), use_count = use_count + 1
      WHERE id = $1 AND user_id = $2
    `, [parseInt(req.params.id), req.user.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Mark plan used error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
