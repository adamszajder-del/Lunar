// News Routes - /api/news/*
// Fixes: #1 atomic toggles, #7 removed information_schema, #8 standardized format, #12 shared reactions
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { validateId } = require('../middleware/validateId');
const { sanitizeString } = require('../utils/validators');
const { atomicToggleLike } = require('../utils/reactions');
const log = require('../utils/logger');

// Get all news (public) — Fix #10: pagination
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 500));
    const offset = (page - 1) * limit;

    const result = await db.query(
      'SELECT * FROM news ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    res.json(result.rows);
  } catch (error) {
    log.error('Get news error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all news with read status (authenticated) - excludes hidden
// Fix #7: removed information_schema check (table always exists now)
router.get('/with-status', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
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
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    log.error('Get news with status error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get unread news count (excludes hidden)
// Fix #7: removed information_schema check
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
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
    `, [req.user.id]);
    res.json({ unread_count: parseInt(result.rows[0].count) });
  } catch (error) {
    log.error('Get unread count error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark single news as read
router.post('/:id/read', validateId('id'), authMiddleware, async (req, res) => {
  try {
    await db.query(`
      INSERT INTO user_news_read (user_id, news_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, news_id) DO NOTHING
    `, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Mark news read error', { error });
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
    log.error('Mark all read error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Hide news — Fix #7: removed information_schema check
router.post('/:id/hide', validateId('id'), authMiddleware, async (req, res) => {
  try {
    await db.query(`
      INSERT INTO user_news_hidden (user_id, news_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, news_id) DO NOTHING
    `, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Hide news error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Unhide news — Fix #7: removed information_schema check
router.delete('/:id/hide', validateId('id'), authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_news_hidden WHERE user_id = $1 AND news_id = $2',
      [req.user.id, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    log.error('Unhide news error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NEWS LIKES & COMMENTS ====================

// Get reactions for a single news item — Fix #12: batch comment likes
router.get('/:id/reactions', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id);
    const userId = req.user.id;
    
    // Get likes count + user liked in one query
    const likesResult = await db.query(`
      SELECT COUNT(*) as count, BOOL_OR(user_id = $2) as user_liked
      FROM news_likes WHERE news_id = $1
    `, [newsId, userId]);
    
    const likesCount = parseInt(likesResult.rows[0]?.count) || 0;
    const userLiked = likesResult.rows[0]?.user_liked || false;
    
    // Get comments
    const commentsResult = await db.query(`
      SELECT nc.id, nc.content, nc.created_at, nc.user_id as author_id,
             u.username, u.display_name, u.avatar_base64
      FROM news_comments nc
      JOIN users u ON nc.user_id = u.id
      WHERE nc.news_id = $1
        AND (nc.is_deleted IS NULL OR nc.is_deleted = false)
      ORDER BY nc.created_at ASC
    `, [newsId]);
    
    // Batch get comment likes
    const commentIds = commentsResult.rows.map(c => c.id);
    let commentLikesMap = {};
    
    if (commentIds.length > 0) {
      const clResult = await db.query(`
        SELECT comment_id, COUNT(*) as count, BOOL_OR(user_id = $1) as user_liked
        FROM news_comment_likes WHERE comment_id = ANY($2)
        GROUP BY comment_id
      `, [userId, commentIds]);
      
      clResult.rows.forEach(r => {
        commentLikesMap[r.comment_id] = { likes_count: parseInt(r.count), user_liked: r.user_liked };
      });
    }
    
    const comments = commentsResult.rows.map(comment => {
      const cl = commentLikesMap[comment.id] || { likes_count: 0, user_liked: false };
      return { ...comment, likes_count: cl.likes_count, user_liked: cl.user_liked };
    });
    
    // Fix #8: return both formats for backward compat
    res.json({
      likes_count: likesCount,
      comments_count: comments.length,
      user_liked: userLiked,
      // backward compat
      likesCount,
      commentsCount: comments.length,
      userLiked,
      comments,
    });
  } catch (error) {
    log.error('Get news reactions error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on news — Fix #1: atomic toggle
router.post('/:id/like', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id);
    const userId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'news_likes',
      { news_id: newsId, user_id: userId },
      { news_id: newsId }
    );
    
    // Fix #8: return both formats
    res.json({
      liked: userLiked,
      user_liked: userLiked,
      likes_count: likesCount,
      likesCount,
    });
  } catch (error) {
    log.error('Toggle news like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to news
router.post('/:id/comment', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id);
    const userId = req.user.id;
    const { content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    
    const safeContent = sanitizeString(content, 1000);
    
    const result = await db.query(`
      INSERT INTO news_comments (news_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [newsId, userId, safeContent]);
    
    res.json({
      id: result.rows[0].id,
      content: safeContent,
      created_at: result.rows[0].created_at,
      author_id: userId,
      username: req.user.username,
      display_name: req.user.display_name,
      avatar_base64: req.user.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    log.error('Add news comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete comment from news
router.delete('/:newsId/comments/:commentId', validateId('newsId', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;
    
    const comment = await db.query('SELECT user_id FROM news_comments WHERE id = $1', [commentId]);
    
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (comment.rows[0].user_id !== userId && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await db.query('DELETE FROM news_comments WHERE id = $1', [commentId]);
    res.json({ success: true });
  } catch (error) {
    log.error('Delete news comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Like comment on news — Fix #1: atomic toggle
router.post('/:newsId/comments/:commentId/like', validateId('newsId', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const userId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'news_comment_likes',
      { comment_id: commentId, user_id: userId },
      { comment_id: commentId }
    );
    
    // Fix #8: return both formats
    res.json({
      liked: userLiked,
      user_liked: userLiked,
      likes_count: likesCount,
      likesCount,
    });
  } catch (error) {
    log.error('Toggle news comment like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
