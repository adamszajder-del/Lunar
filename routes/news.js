// News Routes - /api/news/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Get all news (public)
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM news ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all news with read status (authenticated) - excludes hidden
router.get('/with-status', authMiddleware, async (req, res) => {
  try {
    // Check if user_news_hidden table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_news_hidden'
      )
    `);
    const hiddenTableExists = tableCheck.rows[0].exists;
    
    let query;
    if (hiddenTableExists) {
      query = `
        SELECT 
          n.*,
          CASE WHEN unr.id IS NOT NULL THEN true ELSE false END as is_read,
          unr.read_at
        FROM news n
        LEFT JOIN user_news_read unr ON n.id = unr.news_id AND unr.user_id = $1
        WHERE NOT EXISTS (
          SELECT 1 FROM user_news_hidden unh 
          WHERE unh.news_id = n.id AND unh.user_id = $1
        )
        ORDER BY n.created_at DESC
      `;
    } else {
      // Fallback without hidden filter
      query = `
        SELECT 
          n.*,
          CASE WHEN unr.id IS NOT NULL THEN true ELSE false END as is_read,
          unr.read_at
        FROM news n
        LEFT JOIN user_news_read unr ON n.id = unr.news_id AND unr.user_id = $1
        ORDER BY n.created_at DESC
      `;
    }
    
    const result = await db.query(query, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news with status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get unread news count (excludes hidden)
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    // Check if user_news_hidden table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_news_hidden'
      )
    `);
    const hiddenTableExists = tableCheck.rows[0].exists;
    
    let query;
    if (hiddenTableExists) {
      query = `
        SELECT COUNT(*) as count 
        FROM news n
        WHERE NOT EXISTS (
          SELECT 1 FROM user_news_read unr 
          WHERE unr.news_id = n.id AND unr.user_id = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_news_hidden unh 
          WHERE unh.news_id = n.id AND unh.user_id = $1
        )
      `;
    } else {
      query = `
        SELECT COUNT(*) as count 
        FROM news n
        WHERE NOT EXISTS (
          SELECT 1 FROM user_news_read unr 
          WHERE unr.news_id = n.id AND unr.user_id = $1
        )
      `;
    }
    
    const result = await db.query(query, [req.user.id]);
    res.json({ unread_count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark single news as read
router.post('/:id/read', authMiddleware, async (req, res) => {
  try {
    await db.query(`
      INSERT INTO user_news_read (user_id, news_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, news_id) DO NOTHING
    `, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Mark news read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark all news as read
router.post('/read-all', authMiddleware, async (req, res) => {
  try {
    await db.query(`
      INSERT INTO user_news_read (user_id, news_id)
      SELECT $1, n.id FROM news n
      WHERE NOT EXISTS (
        SELECT 1 FROM user_news_read unr 
        WHERE unr.news_id = n.id AND unr.user_id = $1
      )
    `, [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Hide news (soft delete)
router.post('/:id/hide', authMiddleware, async (req, res) => {
  try {
    // Check if table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_news_hidden'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.status(500).json({ error: 'Migration required: run /api/run-news-hidden-migration' });
    }
    
    await db.query(`
      INSERT INTO user_news_hidden (user_id, news_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, news_id) DO NOTHING
    `, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Hide news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unhide news (restore)
router.delete('/:id/hide', authMiddleware, async (req, res) => {
  try {
    // Check if table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_news_hidden'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ success: true }); // Nothing to unhide
    }
    
    await db.query(`
      DELETE FROM user_news_hidden 
      WHERE user_id = $1 AND news_id = $2
    `, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Unhide news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
