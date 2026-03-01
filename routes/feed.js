// Feed Routes - /api/feed/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { ACHIEVEMENTS } = require('./achievements');
const { sanitizeString } = require('../utils/validators');
const { createAccountRateLimiter } = require('../middleware/rateLimit');

// Fix SEC-CRIT-4: per-account limiter on feed (heaviest query in the system)
const feedLimiter = createAccountRateLimiter({ prefix: 'feed', maxRequests: 30, windowMs: 60000 });

// Get activity feed for followed users
router.get('/', authMiddleware, feedLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 15;
    const offset = parseInt(req.query.offset) || 0;

    // Feed filters (optional)
    const validTypes = ['trick_mastered', 'trick_started', 'achievement_earned', 'event_joined', 'user_post'];
    const typeFilter = req.query.types
      ? req.query.types.split(',').filter(t => validTypes.includes(t))
      : null;
    const mineOnly = req.query.mine === 'true';

    // Get list of followed user IDs
    const followedResult = await db.query(
      `SELECT item_id FROM favorites WHERE user_id = $1 AND item_type = 'user'`,
      [userId]
    );
    const followedIds = followedResult.rows.map(r => r.item_id);
    
    // Always include own posts in feed so user can track their likes/comments
    if (!followedIds.includes(userId)) {
      followedIds.push(userId);
    }
    
    // If no followed users (and only self), still show feed
    if (followedIds.length === 0) {
      return res.json({ items: [], hasMore: false });
    }

    // Query tricks with likes and comments counts from unified tables
    // Plus event registrations
    // Plus achievements
    const feedQuery = `
      WITH trick_feed AS (
        SELECT 
          CASE WHEN ut.status = 'mastered' THEN 'trick_mastered' ELSE 'trick_started' END as type,
          ut.user_id,
          ut.trick_id,
          NULL::integer as event_id,
          NULL::text as achievement_id,
          NULL::integer as post_id,
          COALESCE(ut.updated_at, NOW()) as created_at,
          json_build_object(
            'trick_id', t.id,
            'trick_name', t.name,
            'category', t.category
          ) as data,
          u.username,
          u.display_name,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          u.country_flag,
          COALESCE(ut.likes_count, 0) as likes_count,
          COALESCE(ut.comments_count, 0) as comments_count,
          CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked,
          (SELECT LEFT(tc.content, 50) FROM trick_comments tc WHERE tc.owner_id = ut.user_id AND tc.trick_id = ut.trick_id AND (tc.is_deleted IS NULL OR tc.is_deleted = false) ORDER BY tc.created_at DESC LIMIT 1) as latest_comment
        FROM user_tricks ut
        JOIN tricks t ON ut.trick_id = t.id
        JOIN users u ON ut.user_id = u.id
        LEFT JOIN trick_likes user_like ON user_like.owner_id = ut.user_id 
          AND user_like.trick_id = ut.trick_id 
          AND user_like.liker_id = $4
        WHERE ut.user_id = ANY($1)
          AND (ut.status IN ('mastered', 'in_progress') OR COALESCE(ut.goofy_status, 'todo') IN ('mastered', 'in_progress'))
      ),
      event_feed AS (
        SELECT 
          'event_joined' as type,
          ea.user_id,
          NULL::integer as trick_id,
          ea.event_id,
          NULL::text as achievement_id,
          NULL::integer as post_id,
          COALESCE(ea.registered_at, NOW()) as created_at,
          json_build_object(
            'event_id', e.id,
            'event_title', e.name,
            'event_date', e.date,
            'event_time', e.time,
            'event_location', e.location,
            'event_spots', e.spots,
            'event_attendees', (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id),
            'event_creator', creator.display_name,
            'event_creator_username', creator.username
          ) as data,
          u.username,
          u.display_name,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          u.country_flag,
          0::bigint as likes_count,
          0::bigint as comments_count,
          false as user_liked,
          NULL::text as latest_comment
        FROM event_attendees ea
        JOIN events e ON ea.event_id = e.id
        JOIN users u ON ea.user_id = u.id
        LEFT JOIN users creator ON e.author_id = creator.id
        WHERE ea.user_id = ANY($1)
      ),
      achievement_feed AS (
        SELECT 
          'achievement_earned' as type,
          ua.user_id,
          NULL::integer as trick_id,
          NULL::integer as event_id,
          ua.achievement_id,
          NULL::integer as post_id,
          COALESCE(ua.achieved_at, NOW()) as created_at,
          json_build_object(
            'achievement_id', ua.achievement_id,
            'achievement_name', ua.achievement_id,
            'tier', ua.tier,
            'icon', ua.achievement_id
          ) as data,
          u.username,
          u.display_name,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          u.country_flag,
          COALESCE(ua.likes_count, 0) as likes_count,
          COALESCE(ua.comments_count, 0) as comments_count,
          CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked,
          (SELECT LEFT(ac.content, 50) FROM achievement_comments ac WHERE ac.owner_id = ua.user_id AND ac.achievement_id = ua.achievement_id AND (ac.is_deleted IS NULL OR ac.is_deleted = false) ORDER BY ac.created_at DESC LIMIT 1) as latest_comment
        FROM user_achievements ua
        JOIN users u ON ua.user_id = u.id
        LEFT JOIN achievement_likes user_like ON user_like.owner_id = ua.user_id 
          AND user_like.achievement_id = ua.achievement_id 
          AND user_like.liker_id = $4
        WHERE ua.user_id = ANY($1)
      ),
      post_feed AS (
        SELECT
          'user_post' as type,
          p.user_id,
          NULL::integer as trick_id,
          NULL::integer as event_id,
          NULL::text as achievement_id,
          p.id as post_id,
          p.created_at,
          json_build_object('content', p.content) as data,
          u.username,
          u.display_name,
          u.is_coach,
          u.is_staff,
          u.is_club_member,
          u.country_flag,
          COALESCE(p.likes_count, 0) as likes_count,
          COALESCE(p.comments_count, 0) as comments_count,
          CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked,
          (SELECT LEFT(pc.content, 50) FROM post_comments pc WHERE pc.post_id = p.id AND (pc.is_deleted IS NULL OR pc.is_deleted = false) ORDER BY pc.created_at DESC LIMIT 1) as latest_comment
        FROM user_posts p
        JOIN users u ON p.user_id = u.id
        LEFT JOIN post_likes user_like ON user_like.post_id = p.id AND user_like.user_id = $4
        WHERE p.user_id = ANY($1) AND (p.is_deleted IS NULL OR p.is_deleted = false)
      )
      SELECT * FROM (
        SELECT * FROM trick_feed
        UNION ALL
        SELECT * FROM event_feed
        UNION ALL
        SELECT * FROM achievement_feed
        UNION ALL
        SELECT * FROM post_feed
      ) combined
      ${(() => {
        const conditions = [];
        if (typeFilter && typeFilter.length > 0) conditions.push(`combined.type IN (${typeFilter.map(t => `'${t}'`).join(',')})`);
        if (mineOnly) conditions.push(`combined.user_id = $4`);
        return conditions.length > 0 ? `WHERE ${conditions.join(' OR ')}` : '';
      })()}
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(feedQuery, [followedIds, limit + 1, offset, userId]);
    
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => {
      // Get achievement metadata if this is an achievement item
      let data = row.data;
      if (row.type === 'achievement_earned' && row.achievement_id && ACHIEVEMENTS[row.achievement_id]) {
        const achDef = ACHIEVEMENTS[row.achievement_id];
        data = {
          ...data,
          achievement_name: achDef.name,
          icon: achDef.icon,
          tiers: achDef.tiers,
          description: achDef.description
        };
      }
      
      return {
        id: row.post_id
          ? `${row.type}_${row.user_id}_${row.post_id}`
          : row.trick_id 
            ? `${row.type}_${row.user_id}_${row.trick_id}` 
            : row.event_id
              ? `${row.type}_${row.user_id}_${row.event_id}`
              : `${row.type}_${row.user_id}_${row.achievement_id}`,
        type: row.type,
        created_at: row.created_at,
        data: data,
        user: {
          id: row.user_id,
          username: row.username,
          display_name: row.display_name,
          is_coach: row.is_coach,
          is_staff: row.is_staff,
          is_club_member: row.is_club_member,
          country_flag: row.country_flag
        },
        // For unified system - store IDs for API calls
        owner_id: row.user_id,
        trick_id: row.trick_id,
        event_id: row.event_id,
        achievement_id: row.achievement_id,
        post_id: row.post_id,
        reactions_count: parseInt(row.likes_count) || 0,
        user_reacted: row.user_liked,
        comments_count: parseInt(row.comments_count) || 0,
        latest_comment: row.latest_comment || null
      };
    });

    res.json({ items, hasMore });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Server error' });
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
        u.id as user_id, u.username, u.display_name, u.avatar_base64, u.country_flag as author_country_flag
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

    const safeContent = sanitizeString(content, 1000);

    const result = await db.query(`
      INSERT INTO feed_comments (feed_item_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [feedItemId, userId, safeContent]);

    res.json({
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      content: safeContent,
      user_id: userId,
      username: req.user.username,
      display_name: req.user.display_name,
      avatar_base64: req.user.avatar_base64,
      author_country_flag: req.user.country_flag
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

// ═══ NOTIFICATIONS — recent likes & comments on user's content ═══
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 30;
    const lastSeen = req.query.last_seen || null;

    // Core notifications (always available)
    const coreQuery = `
      WITH notifs AS (
        SELECT 'trick_like' as ntype, tl.created_at, tl.liker_id as actor_id,
          u.username as actor_username, u.display_name as actor_display_name, u.country_flag as actor_flag,
          json_build_object('trick_name', t.name, 'trick_id', tl.trick_id, 'owner_id', tl.owner_id) as meta
        FROM trick_likes tl
        JOIN users u ON tl.liker_id = u.id
        JOIN user_tricks ut ON ut.user_id = tl.owner_id AND ut.trick_id = tl.trick_id
        JOIN tricks t ON t.id = tl.trick_id
        WHERE tl.owner_id = $1 AND tl.liker_id != $1

        UNION ALL
        SELECT 'trick_comment' as ntype, tc.created_at, tc.author_id as actor_id,
          u.username, u.display_name, u.country_flag,
          json_build_object('trick_name', t.name, 'trick_id', tc.trick_id, 'owner_id', tc.owner_id, 'content', LEFT(tc.content, 80)) as meta
        FROM trick_comments tc
        JOIN users u ON tc.author_id = u.id
        JOIN tricks t ON t.id = tc.trick_id
        WHERE tc.owner_id = $1 AND tc.author_id != $1 AND (tc.is_deleted IS NULL OR tc.is_deleted = false)

        UNION ALL
        SELECT 'achievement_like' as ntype, al.created_at, al.liker_id as actor_id,
          u.username, u.display_name, u.country_flag,
          json_build_object('achievement_id', al.achievement_id, 'owner_id', al.owner_id) as meta
        FROM achievement_likes al
        JOIN users u ON al.liker_id = u.id
        WHERE al.owner_id = $1 AND al.liker_id != $1

        UNION ALL
        SELECT 'achievement_comment' as ntype, ac.created_at, ac.author_id as actor_id,
          u.username, u.display_name, u.country_flag,
          json_build_object('achievement_id', ac.achievement_id, 'owner_id', ac.owner_id, 'content', LEFT(ac.content, 80)) as meta
        FROM achievement_comments ac
        JOIN users u ON ac.author_id = u.id
        WHERE ac.owner_id = $1 AND ac.author_id != $1 AND (ac.is_deleted IS NULL OR ac.is_deleted = false)

        UNION ALL
        SELECT 'new_follower' as ntype, f.created_at, f.user_id as actor_id,
          u.username, u.display_name, u.country_flag,
          '{}'::json as meta
        FROM favorites f
        JOIN users u ON f.user_id = u.id
        WHERE f.item_type = 'user' AND f.item_id = $1
      )
      SELECT * FROM notifs ORDER BY created_at DESC LIMIT $2
    `;
    
    const coreResult = await db.query(coreQuery, [userId, limit]);
    let allNotifs = coreResult.rows;

    // Post notifications (may not exist yet)
    try {
      const postResult = await db.query(`
        SELECT 'post_like' as ntype, pl.created_at, pl.user_id as actor_id,
          u.username as actor_username, u.display_name as actor_display_name, u.country_flag as actor_flag,
          json_build_object('post_id', pl.post_id, 'content', LEFT(p.content, 80)) as meta
        FROM post_likes pl
        JOIN users u ON pl.user_id = u.id
        JOIN user_posts p ON p.id = pl.post_id
        WHERE p.user_id = $1 AND pl.user_id != $1

        UNION ALL
        SELECT 'post_comment' as ntype, pc.created_at, pc.user_id as actor_id,
          u.username, u.display_name, u.country_flag,
          json_build_object('post_id', pc.post_id, 'content', LEFT(pc.content, 80)) as meta
        FROM post_comments pc
        JOIN users u ON pc.user_id = u.id
        JOIN user_posts p ON p.id = pc.post_id
        WHERE p.user_id = $1 AND pc.user_id != $1 AND (pc.is_deleted IS NULL OR pc.is_deleted = false)

        ORDER BY created_at DESC LIMIT $2
      `, [userId, limit]);
      allNotifs = [...allNotifs, ...postResult.rows];
    } catch { /* post tables may not exist */ }

    // Sort merged and limit
    allNotifs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    allNotifs = allNotifs.slice(0, limit);

    // Count unseen (newer than last_seen)
    let unseenCount = 0;
    if (lastSeen) {
      unseenCount = allNotifs.filter(r => new Date(r.created_at) > new Date(lastSeen)).length;
    } else {
      unseenCount = allNotifs.length;
    }

    res.json({ notifications: allNotifs, unseenCount });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
