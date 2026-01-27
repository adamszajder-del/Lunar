// Feed Routes - /api/feed/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Get activity feed for followed users
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 15;
    const offset = parseInt(req.query.offset) || 0;

    // Get list of followed user IDs
    const followedResult = await db.query(
      `SELECT item_id FROM favorites WHERE user_id = $1 AND item_type = 'user'`,
      [userId]
    );
    const followedIds = followedResult.rows.map(r => r.item_id);
    
    // If no followed users, return empty
    if (followedIds.length === 0) {
      return res.json({ items: [], hasMore: false });
    }

    // Query tricks with likes and comments counts from unified tables
    // Plus event registrations
    const feedQuery = `
      WITH trick_feed AS (
        SELECT 
          CASE WHEN ut.status = 'mastered' THEN 'trick_mastered' ELSE 'trick_started' END as type,
          ut.user_id,
          ut.trick_id,
          NULL::integer as event_id,
          COALESCE(ut.updated_at, NOW()) as created_at,
          json_build_object(
            'trick_id', t.id,
            'trick_name', t.name,
            'category', t.category
          ) as data,
          u.username,
          u.display_name,
          u.avatar_base64,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          COALESCE(likes.count, 0) as likes_count,
          COALESCE(comments.count, 0) as comments_count,
          CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked
        FROM user_tricks ut
        JOIN tricks t ON ut.trick_id = t.id
        JOIN users u ON ut.user_id = u.id
        LEFT JOIN (
          SELECT owner_id, trick_id, COUNT(*) as count 
          FROM trick_likes 
          GROUP BY owner_id, trick_id
        ) likes ON likes.owner_id = ut.user_id AND likes.trick_id = ut.trick_id
        LEFT JOIN (
          SELECT owner_id, trick_id, COUNT(*) as count 
          FROM trick_comments 
          GROUP BY owner_id, trick_id
        ) comments ON comments.owner_id = ut.user_id AND comments.trick_id = ut.trick_id
        LEFT JOIN trick_likes user_like ON user_like.owner_id = ut.user_id 
          AND user_like.trick_id = ut.trick_id 
          AND user_like.liker_id = $4
        WHERE ut.user_id = ANY($1)
          AND ut.status IN ('mastered', 'in_progress')
      ),
      event_feed AS (
        SELECT 
          'event_joined' as type,
          ea.user_id,
          NULL::integer as trick_id,
          ea.event_id,
          COALESCE(ea.joined_at, ea.created_at, NOW()) as created_at,
          json_build_object(
            'event_id', e.id,
            'event_title', e.name,
            'event_date', e.date,
            'event_location', e.location
          ) as data,
          u.username,
          u.display_name,
          u.avatar_base64,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          0::bigint as likes_count,
          0::bigint as comments_count,
          false as user_liked
        FROM event_attendees ea
        JOIN events e ON ea.event_id = e.id
        JOIN users u ON ea.user_id = u.id
        WHERE ea.user_id = ANY($1)
      )
      SELECT * FROM (
        SELECT * FROM trick_feed
        UNION ALL
        SELECT * FROM event_feed
      ) combined
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(feedQuery, [followedIds, limit + 1, offset, userId]);
    
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => ({
      id: row.trick_id 
        ? `${row.type}_${row.user_id}_${row.trick_id}` 
        : `${row.type}_${row.user_id}_${row.event_id}`,
      type: row.type,
      created_at: row.created_at,
      data: row.data,
      user: {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_base64: row.avatar_base64,
        is_coach: row.is_coach,
        is_staff: row.is_staff,
        is_club_member: row.is_club_member
      },
      // For unified system - store owner_id and trick_id for API calls
      owner_id: row.user_id,
      trick_id: row.trick_id,
      event_id: row.event_id,
      reactions_count: parseInt(row.likes_count) || 0,
      user_reacted: row.user_liked,
      comments_count: parseInt(row.comments_count) || 0
    }));

    res.json({ items, hasMore });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Legacy endpoints - kept for backwards compatibility but not used for tricks anymore
// Toggle reaction on feed item (only for non-trick items like events/achievements)
router.post('/react', authMiddleware, async (req, res) => {
  try {
    const { feedItemId } = req.body;
    const userId = req.user.id;

    // Check if already reacted
    const existing = await db.query(
      'SELECT id FROM feed_reactions WHERE feed_item_id = $1 AND user_id = $2',
      [feedItemId, userId]
    );

    if (existing.rows.length > 0) {
      await db.query(
        'DELETE FROM feed_reactions WHERE feed_item_id = $1 AND user_id = $2',
        [feedItemId, userId]
      );
      res.json({ reacted: false });
    } else {
      await db.query(
        'INSERT INTO feed_reactions (feed_item_id, user_id) VALUES ($1, $2)',
        [feedItemId, userId]
      );
      res.json({ reacted: true });
    }
  } catch (error) {
    console.error('Toggle reaction error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get comments for feed item (legacy - for non-trick items)
router.get('/comments/:feedItemId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        fc.id, fc.content, fc.created_at,
        u.id as user_id, u.username, u.display_name, u.avatar_base64
      FROM feed_comments fc
      JOIN users u ON fc.user_id = u.id
      WHERE fc.feed_item_id = $1
      ORDER BY fc.created_at ASC
    `, [req.params.feedItemId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to feed item (legacy - for non-trick items)
router.post('/comments', authMiddleware, async (req, res) => {
  try {
    const { feedItemId, content } = req.body;
    const userId = req.user.id;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    const result = await db.query(`
      INSERT INTO feed_comments (feed_item_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [feedItemId, userId, content.trim()]);

    res.json({
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      content: content.trim(),
      user_id: userId,
      username: req.user.username,
      display_name: req.user.display_name,
      avatar_base64: req.user.avatar_base64
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete comment (legacy)
router.delete('/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM feed_comments WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.commentId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
