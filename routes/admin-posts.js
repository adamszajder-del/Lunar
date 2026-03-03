// routes/admin-posts.js
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin required' });
  next();
});

// Auto-create tables on startup
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        image_base64 TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS post_likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(post_id, user_id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS post_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id)`);
    console.log('✅ Posts tables ready');
  } catch (e) {
    console.warn('Posts tables:', e.message);
  }
})();

// GET /api/admin/posts
router.get('/posts', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.id, p.user_id, p.content, p.image_base64, p.created_at,
        u.username, u.display_name,
        COALESCE(lk.cnt, 0)::int as likes_count,
        COALESCE(cm.cnt, 0)::int as comments_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN (SELECT post_id, COUNT(*) as cnt FROM post_likes GROUP BY post_id) lk ON lk.post_id = p.id
      LEFT JOIN (SELECT post_id, COUNT(*) as cnt FROM post_comments WHERE is_deleted = false GROUP BY post_id) cm ON cm.post_id = p.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Admin GET /posts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/posts/:id
router.delete('/posts/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin DELETE /posts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
