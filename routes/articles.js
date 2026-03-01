// Articles Routes - /api/articles/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { cache, TTL } = require('../utils/cache');
const { validateId } = require('../middleware/validateId');

// Get article categories (lightweight — names + counts, for category grid)
router.get('/categories', async (req, res) => {
  try {
    const cached = cache.get('articles:categories');
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT category, COUNT(*) as article_count
      FROM articles 
      GROUP BY category
      ORDER BY category
    `);
    cache.set('articles:categories', result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    log.error('Get article categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all articles (listing — no content, for catalog/progress)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = parseInt(req.query.offset) || 0;
    const cacheKey = `articles:${limit}:${offset}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT a.id, a.public_id, a.category, a.title, a.description, a.read_time, a.image_url, a.author_id, a.created_at,
             a.difficulty, a.article_type,
             u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      ORDER BY a.category, a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    cache.set(cacheKey, result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    log.error('Get articles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get articles by category
router.get('/category/:category', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.id, a.public_id, a.category, a.title, a.description, a.read_time, a.image_url, a.author_id, a.created_at,
             a.difficulty, a.article_type,
             u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      WHERE a.category = $1
      ORDER BY a.created_at DESC
    `, [req.params.category]);
    res.json(result.rows);
  } catch (error) {
    log.error('Get articles by category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single article
router.get('/:id', validateId('id'), async (req, res) => {
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
    log.error('Get article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's article progress
router.get('/user/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT article_id, status FROM user_articles WHERE user_id = $1',
      [req.user.id]
    );
    
    const progress = {};
    result.rows.forEach(row => {
      progress[row.article_id] = row.status;
    });
    
    res.json(progress);
  } catch (error) {
    log.error('Get article progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update article progress
router.put('/user/:articleId', validateId('articleId'), authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const articleId = req.params.articleId;

    const validStatuses = ['fresh', 'to_read', 'known'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: fresh, to_read, or known' });
    }

    await db.query(`
      INSERT INTO user_articles (user_id, article_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET status = $3, updated_at = NOW()
    `, [req.user.id, articleId, status]);

    res.json({ success: true });
  } catch (error) {
    log.error('Update article progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
