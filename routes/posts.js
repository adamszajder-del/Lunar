// Posts Routes - /api/posts/*
// User-generated text posts with likes and comments

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');
const { createAccountRateLimiter } = require('../middleware/rateLimit');
const log = require('../utils/logger');

const postLimiter = createAccountRateLimiter({ prefix: 'post', maxRequests: 10, windowMs: 60000 });

// ─── CREATE POST ───
router.post('/', authMiddleware, postLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Post cannot be empty' });
    }
    if (content.trim().length > 2000) {
      return res.status(400).json({ error: 'Post too long (max 2000 chars)' });
    }

    const safeContent = sanitizeString(content, 2000);

    const result = await db.query(
      `INSERT INTO user_posts (user_id, content) VALUES ($1, $2) RETURNING id, created_at`,
      [userId, safeContent]
    );

    const post = result.rows[0];
    log.info('Post created', { userId, postId: post.id });

    res.json({
      id: post.id,
      user_id: userId,
      content: safeContent,
      likes_count: 0,
      comments_count: 0,
      created_at: post.created_at,
      user: {
        id: userId,
        username: req.user.username,
        display_name: req.user.display_name,
        is_coach: req.user.is_coach,
        is_staff: req.user.is_staff,
        is_club_member: req.user.is_club_member,
        country_flag: req.user.country_flag
      }
    });
  } catch (error) {
    log.error('Create post error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE POST (own only) ───
router.delete('/:postId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE user_posts SET is_deleted = true WHERE id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = false) RETURNING id`,
      [req.params.postId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ success: true });
  } catch (error) {
    log.error('Delete post error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── LIKE / UNLIKE POST ───
router.post('/:postId/like', authMiddleware, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    const userId = req.user.id;

    // Atomic toggle
    const del = await db.query(
      `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING id`,
      [postId, userId]
    );

    let userLiked;
    if (del.rows.length > 0) {
      userLiked = false;
    } else {
      await db.query(
        `INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [postId, userId]
      );
      userLiked = true;
    }

    // Update cached count
    const countRes = await db.query(
      `SELECT COUNT(*) as count FROM post_likes WHERE post_id = $1`, [postId]
    );
    const likesCount = parseInt(countRes.rows[0].count) || 0;
    await db.query(`UPDATE user_posts SET likes_count = $1 WHERE id = $2`, [likesCount, postId]);

    res.json({ userLiked, likesCount });
  } catch (error) {
    log.error('Post like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET COMMENTS ───
router.get('/:postId/comments', authMiddleware, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    const userId = req.user.id;

    const result = await db.query(`
      SELECT 
        pc.id, pc.content, pc.created_at, pc.user_id as author_id,
        u.username as author_username, u.display_name as author_display_name, 
        u.country_flag as author_country_flag
      FROM post_comments pc
      JOIN users u ON pc.user_id = u.id
      WHERE pc.post_id = $1 AND (pc.is_deleted IS NULL OR pc.is_deleted = false)
      ORDER BY pc.created_at ASC
    `, [postId]);

    // Get like counts for comments
    if (result.rows.length > 0) {
      const commentIds = result.rows.map(r => r.id);
      const likesRes = await db.query(`
        SELECT comment_id, COUNT(*) as count, BOOL_OR(user_id = $1) as user_liked
        FROM post_comment_likes
        WHERE comment_id = ANY($2)
        GROUP BY comment_id
      `, [userId, commentIds]);

      const likesMap = {};
      likesRes.rows.forEach(r => { likesMap[r.comment_id] = { count: parseInt(r.count), user_liked: r.user_liked }; });

      result.rows.forEach(r => {
        const likes = likesMap[r.id] || { count: 0, user_liked: false };
        r.likes_count = likes.count;
        r.user_liked = likes.user_liked;
      });
    }

    res.json(result.rows);
  } catch (error) {
    log.error('Get post comments error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADD COMMENT ───
router.post('/:postId/comment', authMiddleware, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    const userId = req.user.id;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    const safeContent = sanitizeString(content, 1000);

    const result = await db.query(
      `INSERT INTO post_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [postId, userId, safeContent]
    );

    // Update cached count
    const countRes = await db.query(
      `SELECT COUNT(*) as count FROM post_comments WHERE post_id = $1 AND (is_deleted IS NULL OR is_deleted = false)`, [postId]
    );
    await db.query(`UPDATE user_posts SET comments_count = $1 WHERE id = $2`, [parseInt(countRes.rows[0].count) || 0, postId]);

    res.json({
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      content: safeContent,
      author_id: userId,
      author_username: req.user.username,
      author_display_name: req.user.display_name,
      author_country_flag: req.user.country_flag,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    log.error('Add post comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE COMMENT (own only) ───
router.delete('/:postId/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE post_comments SET is_deleted = true WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.commentId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Update cached count
    const postId = parseInt(req.params.postId);
    const countRes = await db.query(
      `SELECT COUNT(*) as count FROM post_comments WHERE post_id = $1 AND (is_deleted IS NULL OR is_deleted = false)`, [postId]
    );
    await db.query(`UPDATE user_posts SET comments_count = $1 WHERE id = $2`, [parseInt(countRes.rows[0].count) || 0, postId]);

    res.json({ success: true });
  } catch (error) {
    log.error('Delete post comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── LIKE COMMENT ───
router.post('/:postId/comments/:commentId/like', authMiddleware, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const userId = req.user.id;

    const del = await db.query(
      `DELETE FROM post_comment_likes WHERE comment_id = $1 AND user_id = $2 RETURNING id`,
      [commentId, userId]
    );

    let userLiked;
    if (del.rows.length > 0) {
      userLiked = false;
    } else {
      await db.query(
        `INSERT INTO post_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [commentId, userId]
      );
      userLiked = true;
    }

    const countRes = await db.query(
      `SELECT COUNT(*) as count FROM post_comment_likes WHERE comment_id = $1`, [commentId]
    );

    res.json({ userLiked, likesCount: parseInt(countRes.rows[0].count) || 0 });
  } catch (error) {
    log.error('Post comment like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
