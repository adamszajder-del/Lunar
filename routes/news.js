// News Routes - /api/news/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

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

// Get all news with read status (authenticated)
router.get('/with-status', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        n.*,
        CASE WHEN unr.id IS NOT NULL THEN true ELSE false END as is_read,
        unr.read_at
      FROM news n
      LEFT JOIN user_news_read unr ON n.id = unr.news_id AND unr.user_id = $1
      ORDER BY n.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news with status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get unread news count
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT COUNT(*) as count 
      FROM news n
      WHERE NOT EXISTS (
        SELECT 1 FROM user_news_read unr 
        WHERE unr.news_id = n.id AND unr.user_id = $1
      )
    `, [req.user.id]);
    res.json({ unread_count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark single news as read
router.post('/:id/read', authenticateToken, async (req, res) => {
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
router.post('/read-all', authenticateToken, async (req, res) => {
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

module.exports = router;
