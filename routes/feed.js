// Feed Routes - /api/feed/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Get activity feed for followed users
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 30;
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

    // Build UNION query for all activity types
    const feedQuery = `
      WITH feed_items AS (
        -- Tricks mastered
        SELECT 
          'trick_mastered' as type,
          ut.user_id,
          ut.updated_at as created_at,
          json_build_object(
            'trick_id', t.id,
            'trick_name', t.name,
            'category', t.category,
            'difficulty', t.difficulty
          ) as data
        FROM user_tricks ut
        JOIN tricks t ON ut.trick_id = t.id
        WHERE ut.user_id = ANY($1) 
          AND ut.status = 'mastered'
          AND ut.updated_at > NOW() - INTERVAL '30 days'
        
        UNION ALL
        
        -- Tricks started (in_progress)
        SELECT 
          'trick_started' as type,
          ut.user_id,
          ut.updated_at as created_at,
          json_build_object(
            'trick_id', t.id,
            'trick_name', t.name,
            'category', t.category,
            'difficulty', t.difficulty
          ) as data
        FROM user_tricks ut
        JOIN tricks t ON ut.trick_id = t.id
        WHERE ut.user_id = ANY($1) 
          AND ut.status = 'in_progress'
          AND ut.updated_at > NOW() - INTERVAL '30 days'
        
        UNION ALL
        
        -- Achievements earned (automatic)
        SELECT 
          'achievement_earned' as type,
          ua.user_id,
          ua.achieved_at as created_at,
          json_build_object(
            'achievement_id', a.id,
            'achievement_name', a.name,
            'tier', ua.tier,
            'icon', a.icon,
            'description', a.description
          ) as data
        FROM user_achievements ua
        JOIN achievements a ON ua.achievement_id = a.id
        WHERE ua.user_id = ANY($1)
          AND ua.achieved_at > NOW() - INTERVAL '30 days'
        
        UNION ALL
        
        -- Achievements earned (manual)
        SELECT 
          'achievement_earned' as type,
          uma.user_id,
          uma.awarded_at as created_at,
          json_build_object(
            'achievement_id', a.id,
            'achievement_name', a.name,
            'tier', COALESCE(uma.tier, 'special'),
            'icon', a.icon,
            'description', a.description
          ) as data
        FROM user_manual_achievements uma
        JOIN achievements a ON uma.achievement_id = a.id
        WHERE uma.user_id = ANY($1)
          AND uma.awarded_at > NOW() - INTERVAL '30 days'
        
        UNION ALL
        
        -- Events joined
        SELECT 
          'event_joined' as type,
          ea.user_id,
          ea.created_at,
          json_build_object(
            'event_id', e.id,
            'event_name', e.name,
            'event_date', e.date,
            'event_time', e.time,
            'location', e.location,
            'spots', e.spots,
            'attendees', (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id)
          ) as data
        FROM event_attendees ea
        JOIN events e ON ea.event_id = e.id
        WHERE ea.user_id = ANY($1)
          AND ea.created_at > NOW() - INTERVAL '30 days'
          AND e.date >= CURRENT_DATE
      )
      SELECT 
        fi.*,
        u.username,
        u.display_name,
        u.avatar_base64,
        u.is_coach,
        u.is_staff,
        u.is_club_member
      FROM feed_items fi
      JOIN users u ON fi.user_id = u.id
      ORDER BY fi.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(feedQuery, [followedIds, limit + 1, offset]);
    
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => ({
      id: `${row.type}_${row.user_id}_${new Date(row.created_at).getTime()}`,
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
      }
    }));

    // Get reactions counts for each item
    const itemIds = items.map(i => i.id);
    if (itemIds.length > 0) {
      const reactionsResult = await db.query(
        `SELECT feed_item_id, COUNT(*) as count 
         FROM feed_reactions 
         WHERE feed_item_id = ANY($1) 
         GROUP BY feed_item_id`,
        [itemIds]
      );
      const reactionCounts = {};
      reactionsResult.rows.forEach(r => {
        reactionCounts[r.feed_item_id] = parseInt(r.count);
      });

      // Get user's reactions
      const userReactionsResult = await db.query(
        `SELECT feed_item_id FROM feed_reactions WHERE feed_item_id = ANY($1) AND user_id = $2`,
        [itemIds, userId]
      );
      const userReacted = new Set(userReactionsResult.rows.map(r => r.feed_item_id));

      // Get comments counts
      const commentsResult = await db.query(
        `SELECT feed_item_id, COUNT(*) as count 
         FROM feed_comments 
         WHERE feed_item_id = ANY($1) 
         GROUP BY feed_item_id`,
        [itemIds]
      );
      const commentCounts = {};
      commentsResult.rows.forEach(r => {
        commentCounts[r.feed_item_id] = parseInt(r.count);
      });

      // Attach to items
      items.forEach(item => {
        item.reactions_count = reactionCounts[item.id] || 0;
        item.user_reacted = userReacted.has(item.id);
        item.comments_count = commentCounts[item.id] || 0;
      });
    }

    res.json({ items, hasMore });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Toggle reaction on feed item
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
      // Remove reaction
      await db.query(
        'DELETE FROM feed_reactions WHERE feed_item_id = $1 AND user_id = $2',
        [feedItemId, userId]
      );
      res.json({ reacted: false });
    } else {
      // Add reaction
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

// Get comments for feed item
router.get('/comments/:feedItemId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        fc.id,
        fc.content,
        fc.created_at,
        u.id as user_id,
        u.username,
        u.display_name,
        u.avatar_base64
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

// Add comment to feed item
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

// Delete comment
router.delete('/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM feed_comments WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.commentId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found or not authorized' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
