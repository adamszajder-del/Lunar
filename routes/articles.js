// Articles Routes - /api/articles/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Get all articles
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      ORDER BY a.category, a.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get articles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get articles by category
router.get('/category/:category', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      WHERE a.category = $1
      ORDER BY a.created_at DESC
    `, [req.params.category]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get articles by category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single article
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      WHERE a.id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's article progress
router.get('/user/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT article_id, status FROM user_article_status WHERE user_id = $1',
      [req.user.id]
    );
    
    const progress = {};
    result.rows.forEach(row => {
      progress[row.article_id] = row.status;
    });
    
    res.json(progress);
  } catch (error) {
    console.error('Get article progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update article progress
router.put('/user/:articleId', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const articleId = req.params.articleId;

    await db.query(`
      INSERT INTO user_article_status (user_id, article_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET status = $3, updated_at = NOW()
    `, [req.user.id, articleId, status]);

    res.json({ success: true });
  } catch (error) {
    console.error('Update article progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
