// Tricks Routes - /api/tricks/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { cache, TTL } = require('../utils/cache');

// Get all tricks (cached)
router.get('/', async (req, res) => {
  try {
    const cached = cache.get('tricks:all');
    if (cached) return res.json(cached);

    const result = await db.query('SELECT * FROM tricks ORDER BY category, difficulty');
    cache.set('tricks:all', result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    console.error('Get tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's trick progress
router.get('/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT trick_id, status, COALESCE(goofy_status, \'todo\') as goofy_status, notes FROM user_tricks WHERE user_id = $1',
      [req.user.id]
    );
    
    // Convert to object format { trickId: { status, goofy_status, notes } }
    const progress = {};
    result.rows.forEach(row => {
      progress[row.trick_id] = { status: row.status, goofy_status: row.goofy_status, notes: row.notes };
    });
    
    res.json(progress);
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick progress
router.post('/progress', authMiddleware, async (req, res) => {
  try {
    const { trickId, status, notes, stance } = req.body;

    if (!trickId) {
      return res.status(400).json({ error: 'Trick ID is required' });
    }

    const validStatuses = ['todo', 'in_progress', 'mastered'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: todo, in_progress, or mastered' });
    }

    if (stance === 'goofy') {
      await db.query(`
        INSERT INTO user_tricks (user_id, trick_id, goofy_status)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, trick_id)
        DO UPDATE SET goofy_status = $3, updated_at = NOW()
      `, [req.user.id, trickId, status]);
    } else {
      await db.query(`
        INSERT INTO user_tricks (user_id, trick_id, status, notes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, trick_id)
        DO UPDATE SET status = $3, notes = $4, updated_at = NOW()
      `, [req.user.id, trickId, status, notes || '']);
    }

    // Invalidate caches that depend on trick progress
    cache.invalidatePrefix('bootstrap:');
    cache.invalidate('crew:all');

    res.json({ success: true });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
