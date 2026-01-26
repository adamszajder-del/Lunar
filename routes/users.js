// Users Routes - /api/users/*
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeEmail } = require('../utils/validators');

// Get all crew members (public profiles)
router.get('/crew', async (req, res) => {
  try {
    let result;
    
    try {
      result = await db.query(`
        SELECT id, public_id, username, display_name, avatar_base64, 
               COALESCE(is_coach, false) as is_coach, 
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               role
        FROM users
        WHERE (is_approved = true OR is_approved IS NULL) AND is_admin = false
        ORDER BY is_coach DESC NULLS LAST, username
      `);
    } catch (err) {
      result = await db.query(`
        SELECT id, public_id, username, display_name
        FROM users
        WHERE is_admin = false OR is_admin IS NULL
        ORDER BY username
      `);
      result.rows = result.rows.map(u => ({
        ...u,
        is_coach: false,
        is_staff: false,
        is_club_member: false,
        role: null,
        avatar_base64: null
      }));
    }
    
    // Add stats
    for (let user of result.rows) {
      try {
        const tricksResult = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
            COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
          FROM user_tricks WHERE user_id = $1
        `, [user.id]);
        user.mastered = parseInt(tricksResult.rows[0]?.mastered) || 0;
        user.in_progress = parseInt(tricksResult.rows[0]?.in_progress) || 0;
      } catch (e) {
        user.mastered = 0;
        user.in_progress = 0;
      }
      
      try {
        const articlesResult = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'known') as articles_read,
            COUNT(*) FILTER (WHERE status = 'to_read') as articles_to_read
          FROM user_article_status WHERE user_id = $1
        `, [user.id]);
        user.articles_read = parseInt(articlesResult.rows[0]?.articles_read) || 0;
        user.articles_to_read = parseInt(articlesResult.rows[0]?.articles_to_read) || 0;
      } catch (e) {
        user.articles_read = 0;
        user.articles_to_read = 0;
      }
    }
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get crew error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Get user's favorites
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT item_type, item_id FROM favorites WHERE user_id = $1',
      [req.user.id]
    );
    
    const favorites = result.rows;
    
    const response = {
      tricks: favorites.filter(f => f.item_type === 'trick').map(f => f.item_id),
      articles: favorites.filter(f => f.item_type === 'article').map(f => f.item_id),
      users: favorites.filter(f => f.item_type === 'user').map(f => f.item_id)
    };
    
    res.json(response);
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Toggle favorite
router.post('/favorites', authMiddleware, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    
    if (!['trick', 'article', 'user'].includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    
    const existing = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
      [req.user.id, item_type, item_id]
    );
    
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
      res.json({ isFavorite: false });
    } else {
      await db.query(
        'INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)',
        [req.user.id, item_type, item_id]
      );
      res.json({ isFavorite: true });
    }
  } catch (err) {
    console.error('Toggle favorite error:', err);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const email = req.body.email ? sanitizeEmail(req.body.email) : null;
    const password = req.body.password;
    const userId = req.user.id;

    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (email) {
      const existing = await db.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    let query, params;
    
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      if (email) {
        query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, email, username';
        params = [email, passwordHash, userId];
      } else {
        query = 'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email, username';
        params = [passwordHash, userId];
      }
    } else if (email) {
      query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, username';
      params = [email, userId];
    } else {
      return res.status(400).json({ error: 'No changes provided' });
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar
router.put('/me/avatar', authMiddleware, async (req, res) => {
  try {
    const { avatar_base64 } = req.body;
    await db.query(
      'UPDATE users SET avatar_base64 = $1 WHERE id = $2',
      [avatar_base64, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Update avatar error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user achievements by ID
router.get('/:id/achievements', async (req, res) => {
  try {
    const userId = req.params.id;
    
    const result = await db.query(`
      SELECT achievement_id, tier, achieved_at
      FROM user_achievements
      WHERE user_id = $1
    `, [userId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get user achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user stats by ID
router.get('/:id/stats', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Trick stats
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) as total
      FROM user_tricks WHERE user_id = $1
    `, [userId]);
    
    // Article stats
    let articlesResult = { rows: [{ known: 0, to_read: 0 }] };
    try {
      articlesResult = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'known') as known,
          COUNT(*) FILTER (WHERE status = 'to_read') as to_read
        FROM user_article_status WHERE user_id = $1
      `, [userId]);
    } catch (e) { /* ignore */ }
    
    // Event stats
    const eventsResult = await db.query(`
      SELECT COUNT(*) as events_attended
      FROM event_attendees WHERE user_id = $1
    `, [userId]);
    
    res.json({
      tricks: tricksResult.rows[0],
      articles: articlesResult.rows[0],
      events: eventsResult.rows[0]
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
