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

// ==================== NEWS LIKES & COMMENTS ====================

// Get reactions for a single news item
router.get('/:id/reactions', authMiddleware, async (req, res) => {
  try {
    const newsId = req.params.id;
    const userId = req.user.id;
    
    // Get likes count
    let likesCount = 0;
    let userLiked = false;
    try {
      const likesResult = await db.query(`SELECT COUNT(*) as count FROM news_likes WHERE news_id = $1`, [newsId]);
      likesCount = parseInt(likesResult.rows[0]?.count) || 0;
      
      const userLikeResult = await db.query(`SELECT 1 FROM news_likes WHERE news_id = $1 AND user_id = $2`, [newsId, userId]);
      userLiked = userLikeResult.rows.length > 0;
    } catch (e) { /* table may not exist */ }
    
    // Get comments
    let comments = [];
    try {
      const commentsResult = await db.query(`
        SELECT nc.id, nc.content, nc.created_at, nc.user_id as author_id,
               u.username, u.display_name, u.avatar_base64
        FROM news_comments nc
        JOIN users u ON nc.user_id = u.id
        WHERE nc.news_id = $1
          AND (nc.is_deleted IS NULL OR nc.is_deleted = false)
        ORDER BY nc.created_at ASC
      `, [newsId]);
      
      for (const comment of commentsResult.rows) {
        let commentLikesCount = 0;
        let commentUserLiked = false;
        try {
          const clResult = await db.query(`SELECT COUNT(*) as count FROM news_comment_likes WHERE comment_id = $1`, [comment.id]);
          commentLikesCount = parseInt(clResult.rows[0]?.count) || 0;
          
          const clUserResult = await db.query(`SELECT 1 FROM news_comment_likes WHERE comment_id = $1 AND user_id = $2`, [comment.id, userId]);
          commentUserLiked = clUserResult.rows.length > 0;
        } catch (e) { /* table may not exist */ }
        
        comments.push({
          ...comment,
          likes_count: commentLikesCount,
          user_liked: commentUserLiked
        });
      }
    } catch (e) { /* table may not exist */ }
    
    res.json({
      likesCount,
      commentsCount: comments.length,
      userLiked,
      comments
    });
  } catch (error) {
    console.error('Get news reactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on news
router.post('/:id/like', authMiddleware, async (req, res) => {
  try {
    const newsId = req.params.id;
    const userId = req.user.id;
    
    // Check if already liked
    const existing = await db.query(`SELECT id FROM news_likes WHERE news_id = $1 AND user_id = $2`, [newsId, userId]);
    
    if (existing.rows.length > 0) {
      await db.query(`DELETE FROM news_likes WHERE news_id = $1 AND user_id = $2`, [newsId, userId]);
    } else {
      await db.query(`INSERT INTO news_likes (news_id, user_id) VALUES ($1, $2)`, [newsId, userId]);
    }
    
    const countResult = await db.query(`SELECT COUNT(*) as count FROM news_likes WHERE news_id = $1`, [newsId]);
    
    res.json({
      liked: existing.rows.length === 0,
      likesCount: parseInt(countResult.rows[0].count) || 0
    });
  } catch (error) {
    console.error('Toggle news like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to news
router.post('/:id/comment', authMiddleware, async (req, res) => {
  try {
    const newsId = req.params.id;
    const userId = req.user.id;
    const { content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    
    const result = await db.query(`
      INSERT INTO news_comments (news_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [newsId, userId, content.trim()]);
    
    res.json({
      id: result.rows[0].id,
      content: content.trim(),
      created_at: result.rows[0].created_at,
      author_id: userId,
      username: req.user.username,
      display_name: req.user.display_name,
      avatar_base64: req.user.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    console.error('Add news comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete comment from news
router.delete('/:newsId/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const { newsId, commentId } = req.params;
    const userId = req.user.id;
    
    // Check if user owns comment or is admin
    const comment = await db.query(`SELECT user_id FROM news_comments WHERE id = $1`, [commentId]);
    
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (comment.rows[0].user_id !== userId && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await db.query(`DELETE FROM news_comments WHERE id = $1`, [commentId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete news comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Like comment on news
router.post('/:newsId/comments/:commentId/like', authMiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;
    
    const existing = await db.query(`SELECT id FROM news_comment_likes WHERE comment_id = $1 AND user_id = $2`, [commentId, userId]);
    
    if (existing.rows.length > 0) {
      await db.query(`DELETE FROM news_comment_likes WHERE comment_id = $1 AND user_id = $2`, [commentId, userId]);
    } else {
      await db.query(`INSERT INTO news_comment_likes (comment_id, user_id) VALUES ($1, $2)`, [commentId, userId]);
    }
    
    const countResult = await db.query(`SELECT COUNT(*) as count FROM news_comment_likes WHERE comment_id = $1`, [commentId]);
    
    res.json({
      liked: existing.rows.length === 0,
      likesCount: parseInt(countResult.rows[0].count) || 0
    });
  } catch (error) {
    console.error('Toggle news comment like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
