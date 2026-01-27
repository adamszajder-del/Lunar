// Users Routes - /api/users/*
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeEmail } = require('../utils/validators');

// Achievement definitions for progress calculation
const ACHIEVEMENTS = {
  trick_master: { id: 'trick_master', name: 'Trick Master', icon: '🏆', type: 'tiered', tiers: { bronze: 5, silver: 15, gold: 30, diamond: 50 } },
  knowledge_seeker: { id: 'knowledge_seeker', name: 'Knowledge Seeker', icon: '📚', type: 'tiered', tiers: { bronze: 3, silver: 8, gold: 15, diamond: 30 } },
  event_enthusiast: { id: 'event_enthusiast', name: 'Event Enthusiast', icon: '📅', type: 'tiered', tiers: { bronze: 3, silver: 10, gold: 20, diamond: 30 } },
  loyal_customer: { id: 'loyal_customer', name: 'Loyal Customer', icon: '💜', type: 'tiered', tiers: { bronze: 3, silver: 10, gold: 25, diamond: 50 } },
  surface_pro: { id: 'surface_pro', name: 'Surface Pro', icon: '🌊', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 10 } },
  air_master: { id: 'air_master', name: 'Air Master', icon: '🚀', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 15 } },
  kicker_king: { id: 'kicker_king', name: 'Kicker King', icon: '⚡', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 12 } },
  rail_rider: { id: 'rail_rider', name: 'Rail Rider', icon: '🛹', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 12 } },
  profile_pro: { id: 'profile_pro', name: 'Profile Pro', icon: '📸', type: 'manual' },
  vip_guest: { id: 'vip_guest', name: 'VIP Guest', icon: '⭐', type: 'manual' },
  competition_winner: { id: 'competition_winner', name: 'Competition Winner', icon: '🥇', type: 'manual' }
};

function determineTier(value, tiers) {
  if (!tiers) return null;
  if (value >= tiers.diamond) return 'diamond';
  if (value >= tiers.gold) return 'gold';
  if (value >= tiers.silver) return 'silver';
  if (value >= tiers.bronze) return 'bronze';
  return null;
}

async function calculateUserAchievementsForUser(userId) {
  const progress = {};
  
  try {
    // Trick stats
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as total_mastered,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'surface') as surface,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'air') as air,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'kicker') as kicker,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'rail') as rail
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
    `, [userId]);
    
    progress.trick_master = parseInt(tricksResult.rows[0]?.total_mastered) || 0;
    progress.surface_pro = parseInt(tricksResult.rows[0]?.surface) || 0;
    progress.air_master = parseInt(tricksResult.rows[0]?.air) || 0;
    progress.kicker_king = parseInt(tricksResult.rows[0]?.kicker) || 0;
    progress.rail_rider = parseInt(tricksResult.rows[0]?.rail) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Articles
    const articlesResult = await db.query(
      `SELECT COUNT(*) as count FROM user_articles WHERE user_id = $1 AND status = 'known'`,
      [userId]
    );
    progress.knowledge_seeker = parseInt(articlesResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Events
    const eventsResult = await db.query(
      `SELECT COUNT(*) as count FROM event_attendees WHERE user_id = $1`,
      [userId]
    );
    progress.event_enthusiast = parseInt(eventsResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Orders
    const ordersResult = await db.query(
      `SELECT COUNT(*) as count FROM orders WHERE user_id = $1`,
      [userId]
    );
    progress.loyal_customer = parseInt(ordersResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  return progress;
}

// Get all crew members (public profiles)
router.get('/crew', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id, u.public_id, u.username, u.display_name, u.avatar_base64, u.created_at,
        COALESCE(u.is_coach, false) as is_coach, 
        COALESCE(u.is_staff, false) as is_staff,
        COALESCE(u.is_club_member, false) as is_club_member,
        u.role,
        COALESCE(trick_stats.mastered, 0) as mastered,
        COALESCE(trick_stats.in_progress, 0) as in_progress,
        COALESCE(article_stats.articles_read, 0) as articles_read,
        COALESCE(article_stats.articles_to_read, 0) as articles_to_read
      FROM users u
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
        FROM user_tricks
        GROUP BY user_id
      ) trick_stats ON trick_stats.user_id = u.id
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(*) FILTER (WHERE status = 'known') as articles_read,
          COUNT(*) FILTER (WHERE status = 'to_read') as articles_to_read
        FROM user_articles
        GROUP BY user_id
      ) article_stats ON article_stats.user_id = u.id
      WHERE (u.is_approved = true OR u.is_approved IS NULL) AND u.is_admin = false
      ORDER BY u.is_coach DESC NULLS LAST, u.username
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get crew error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Get user's favorites
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT item_type, item_id FROM favorites WHERE user_id = $1',
      [req.user.id]
    );
    
    const favorites = result.rows;
    
    const response = {
      tricks: favorites.filter(f => f.item_type === 'trick').map(f => f.item_id),
      articles: favorites.filter(f => f.item_type === 'article').map(f => f.item_id),
      users: favorites.filter(f => f.item_type === 'user').map(f => f.item_id)
    };
    
    res.json(response);
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Toggle favorite
router.post('/favorites', authMiddleware, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    
    if (!['trick', 'article', 'user'].includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    
    const existing = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
      [req.user.id, item_type, item_id]
    );
    
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
      res.json({ isFavorite: false });
    } else {
      await db.query(
        'INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)',
        [req.user.id, item_type, item_id]
      );
      res.json({ isFavorite: true });
    }
  } catch (err) {
    console.error('Toggle favorite error:', err);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Get my followers (users who follow ME)
router.get('/me/followers', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.user_id as follower_id, u.id, u.username, u.avatar_url, u.role
       FROM favorites f
       JOIN users u ON f.user_id = u.id
       WHERE f.item_type = 'user' AND f.item_id = $1
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    
    res.json({ followers: result.rows });
  } catch (err) {
    console.error('Get followers error:', err);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const email = req.body.email ? sanitizeEmail(req.body.email) : null;
    const password = req.body.password;
    const userId = req.user.id;

    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (email) {
      const existing = await db.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    let query, params;
    
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      if (email) {
        query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, email, username';
        params = [email, passwordHash, userId];
      } else {
        query = 'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email, username';
        params = [passwordHash, userId];
      }
    } else if (email) {
      query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, username';
      params = [email, userId];
    } else {
      return res.status(400).json({ error: 'No changes provided' });
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar
router.put('/me/avatar', authMiddleware, async (req, res) => {
  try {
    const { avatar_base64 } = req.body;
    await db.query(
      'UPDATE users SET avatar_base64 = $1 WHERE id = $2',
      [avatar_base64, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Update avatar error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user achievements by ID
router.get('/:id/achievements', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Calculate progress
    const progress = await calculateUserAchievementsForUser(userId);
    
    // Get stored achievements
    const storedResult = await db.query(
      'SELECT achievement_id, tier, achieved_at FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    
    const stored = {};
    storedResult.rows.forEach(row => {
      stored[row.achievement_id] = { tier: row.tier, achieved_at: row.achieved_at };
    });
    
    // Get manual achievements
    let manualResult = { rows: [] };
    try {
      manualResult = await db.query(
        'SELECT achievement_id, awarded_at FROM user_manual_achievements WHERE user_id = $1',
        [userId]
      );
    } catch (e) { /* table may not exist */ }
    
    const manual = {};
    manualResult.rows.forEach(row => {
      manual[row.achievement_id] = { achieved_at: row.awarded_at };
    });
    
    // Build response
    const achievements = [];
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      if (def.type === 'manual') {
        achievements.push({
          id,
          ...def,
          achieved: !!manual[id],
          currentTier: manual[id] ? 'special' : null,
          tier: manual[id] ? 'special' : null,
          progress: manual[id] ? 1 : 0,
          achieved_at: manual[id]?.achieved_at || null
        });
      } else {
        const currentValue = progress[id] || 0;
        const currentTier = determineTier(currentValue, def.tiers);
        
        achievements.push({
          id,
          ...def,
          achieved: !!currentTier,
          currentTier: stored[id]?.tier || currentTier,
          tier: stored[id]?.tier || currentTier,
          progress: currentValue,
          achieved_at: stored[id]?.achieved_at || null
        });
      }
    }
    
    res.json(achievements);
  } catch (error) {
    console.error('Get user achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user stats by ID
router.get('/:id/stats', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Trick stats
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) as total
      FROM user_tricks WHERE user_id = $1
    `, [userId]);
    
    // Article stats
    let articlesResult = { rows: [{ known: 0, to_read: 0 }] };
    try {
      articlesResult = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'known') as known,
          COUNT(*) FILTER (WHERE status = 'to_read') as to_read
        FROM user_articles WHERE user_id = $1
      `, [userId]);
    } catch (e) { /* ignore */ }
    
    // Event stats
    const eventsResult = await db.query(`
      SELECT COUNT(*) as events_attended
      FROM event_attendees WHERE user_id = $1
    `, [userId]);
    
    // Bookings stats
    let bookingsCount = 0;
    try {
      const bookingsResult = await db.query(`
        SELECT COUNT(*) as count
        FROM orders WHERE user_id = $1 AND booking_date IS NOT NULL
      `, [userId]);
      bookingsCount = parseInt(bookingsResult.rows[0]?.count) || 0;
    } catch (e) { /* ignore */ }
    
    res.json({
      tricks: {
        mastered: parseInt(tricksResult.rows[0]?.mastered) || 0,
        inProgress: parseInt(tricksResult.rows[0]?.in_progress) || 0,
        total: parseInt(tricksResult.rows[0]?.total) || 0
      },
      articles: {
        read: parseInt(articlesResult.rows[0]?.known) || 0,
        toRead: parseInt(articlesResult.rows[0]?.to_read) || 0
      },
      events: parseInt(eventsResult.rows[0]?.events_attended) || 0,
      bookings: bookingsCount
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's tricks by ID
router.get('/:id/tricks', async (req, res) => {
  try {
    const userId = req.params.id;
    
    const result = await db.query(`
      SELECT ut.id, ut.trick_id, ut.status, ut.updated_at,
             t.name, t.category, t.difficulty
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
      ORDER BY t.category, t.name
    `, [userId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get user tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get reactions for all user's mastered tricks
router.get('/:id/tricks/reactions', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const viewerId = req.user.id;
    
    // Get all mastered tricks for this user
    const tricksResult = await db.query(`
      SELECT trick_id FROM user_tricks WHERE user_id = $1 AND status = 'mastered'
    `, [ownerId]);
    
    const reactions = [];
    
    for (const trick of tricksResult.rows) {
      // Get likes count
      let likesCount = 0;
      let userLiked = false;
      try {
        const likesResult = await db.query(`
          SELECT COUNT(*) as count FROM trick_likes WHERE owner_id = $1 AND trick_id = $2
        `, [ownerId, trick.trick_id]);
        likesCount = parseInt(likesResult.rows[0]?.count) || 0;
        
        const userLikeResult = await db.query(`
          SELECT 1 FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
        `, [ownerId, trick.trick_id, viewerId]);
        userLiked = userLikeResult.rows.length > 0;
      } catch (e) { /* table may not exist */ }
      
      // Get comments with likes
      let comments = [];
      let commentsCount = 0;
      try {
        const commentsResult = await db.query(`
          SELECT tc.id, tc.content, tc.created_at, tc.author_id,
                 u.username as author_username, u.avatar_base64 as author_avatar
          FROM trick_comments tc
          JOIN users u ON tc.author_id = u.id
          WHERE tc.owner_id = $1 AND tc.trick_id = $2
          ORDER BY tc.created_at ASC
        `, [ownerId, trick.trick_id]);
        
        // Get likes for each comment
        for (const comment of commentsResult.rows) {
          let commentLikesCount = 0;
          let commentUserLiked = false;
          try {
            const clResult = await db.query(`
              SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = $1
            `, [comment.id]);
            commentLikesCount = parseInt(clResult.rows[0]?.count) || 0;
            
            const clUserResult = await db.query(`
              SELECT 1 FROM comment_likes WHERE comment_id = $1 AND user_id = $2
            `, [comment.id, viewerId]);
            commentUserLiked = clUserResult.rows.length > 0;
          } catch (e) { /* table may not exist */ }
          
          comments.push({
            ...comment,
            likes_count: commentLikesCount,
            user_liked: commentUserLiked
          });
        }
        
        const countResult = await db.query(`
          SELECT COUNT(*) as count FROM trick_comments WHERE owner_id = $1 AND trick_id = $2
        `, [ownerId, trick.trick_id]);
        commentsCount = parseInt(countResult.rows[0]?.count) || 0;
      } catch (e) { /* table may not exist */ }
      
      reactions.push({
        trick_id: trick.trick_id,
        likes_count: likesCount,
        comments_count: commentsCount,
        user_liked: userLiked,
        comments: comments
      });
    }
    
    res.json(reactions);
  } catch (error) {
    console.error('Get trick reactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on a trick
router.post('/:id/tricks/:trickId/like', authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const trickId = req.params.trickId;
    const likerId = req.user.id;
    
    // Check if already liked
    const existingLike = await db.query(`
      SELECT id FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
    `, [ownerId, trickId, likerId]);
    
    let userLiked;
    if (existingLike.rows.length > 0) {
      // Unlike
      await db.query(`
        DELETE FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
      `, [ownerId, trickId, likerId]);
      userLiked = false;
    } else {
      // Like
      await db.query(`
        INSERT INTO trick_likes (owner_id, trick_id, liker_id) VALUES ($1, $2, $3)
      `, [ownerId, trickId, likerId]);
      userLiked = true;
      
      // Create notification for owner
      const trickName = await db.query(`SELECT name FROM tricks WHERE id = $1`, [trickId]);
      await createNotification(ownerId, 'trick_like', likerId, 'trick', parseInt(trickId), trickName.rows[0]?.name);
    }
    
    // Get updated count
    const countResult = await db.query(`
      SELECT COUNT(*) as count FROM trick_likes WHERE owner_id = $1 AND trick_id = $2
    `, [ownerId, trickId]);
    
    res.json({
      likes_count: parseInt(countResult.rows[0]?.count) || 0,
      user_liked: userLiked
    });
  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to a trick
router.post('/:id/tricks/:trickId/comment', authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const trickId = req.params.trickId;
    const authorId = req.user.id;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const result = await db.query(`
      INSERT INTO trick_comments (owner_id, trick_id, author_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, content, created_at
    `, [ownerId, trickId, authorId, content.trim()]);
    
    // Get author info
    const authorResult = await db.query(`
      SELECT username, avatar_base64 FROM users WHERE id = $1
    `, [authorId]);
    
    // Create notification for owner
    const trickName = await db.query(`SELECT name FROM tricks WHERE id = $1`, [trickId]);
    await createNotification(ownerId, 'trick_comment', authorId, 'trick', parseInt(trickId), trickName.rows[0]?.name);
    
    res.json({
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      author_id: authorId,
      author_username: authorResult.rows[0]?.username,
      author_avatar: authorResult.rows[0]?.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on a comment
router.post('/:id/tricks/:trickId/comments/:commentId/like', authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    // Check if already liked
    const existingLike = await db.query(`
      SELECT id FROM comment_likes WHERE comment_id = $1 AND user_id = $2
    `, [commentId, userId]);
    
    let userLiked;
    if (existingLike.rows.length > 0) {
      await db.query(`DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2`, [commentId, userId]);
      userLiked = false;
    } else {
      await db.query(`INSERT INTO comment_likes (comment_id, user_id) VALUES ($1, $2)`, [commentId, userId]);
      userLiked = true;
      
      // Create notification for comment author
      const comment = await db.query(`SELECT author_id FROM trick_comments WHERE id = $1`, [commentId]);
      if (comment.rows[0]) {
        await createNotification(comment.rows[0].author_id, 'comment_like', userId, 'comment', parseInt(commentId), null);
      }
    }
    
    const countResult = await db.query(`SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = $1`, [commentId]);
    
    res.json({
      likes_count: parseInt(countResult.rows[0]?.count) || 0,
      user_liked: userLiked
    });
  } catch (error) {
    console.error('Toggle comment like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a comment (only author can delete)
router.delete('/:id/tricks/:trickId/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    // Check if user is the author
    const comment = await db.query(`SELECT author_id FROM trick_comments WHERE id = $1`, [commentId]);
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    if (comment.rows[0].author_id !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    
    await db.query(`DELETE FROM trick_comments WHERE id = $1`, [commentId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ACHIEVEMENT REACTIONS
// ============================================================================

// Get reactions for user's achievements
router.get('/:id/achievements/reactions', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const viewerId = req.user.id;
    
    // Get user's earned achievements
    const achievementsResult = await db.query(`
      SELECT achievement_id FROM user_achievements WHERE user_id = $1
    `, [ownerId]);
    
    const reactions = [];
    
    for (const ach of achievementsResult.rows) {
      // Get likes
      let likesCount = 0;
      let userLiked = false;
      try {
        const likesResult = await db.query(`
          SELECT COUNT(*) as count FROM achievement_likes WHERE owner_id = $1 AND achievement_id = $2
        `, [ownerId, ach.achievement_id]);
        likesCount = parseInt(likesResult.rows[0]?.count) || 0;
        
        const userLikeResult = await db.query(`
          SELECT 1 FROM achievement_likes WHERE owner_id = $1 AND achievement_id = $2 AND liker_id = $3
        `, [ownerId, ach.achievement_id, viewerId]);
        userLiked = userLikeResult.rows.length > 0;
      } catch (e) { /* table may not exist */ }
      
      // Get comments with likes
      let comments = [];
      let commentsCount = 0;
      try {
        const commentsResult = await db.query(`
          SELECT ac.id, ac.content, ac.created_at, ac.author_id,
                 u.username as author_username, u.avatar_base64 as author_avatar
          FROM achievement_comments ac
          JOIN users u ON ac.author_id = u.id
          WHERE ac.owner_id = $1 AND ac.achievement_id = $2
          ORDER BY ac.created_at ASC
        `, [ownerId, ach.achievement_id]);
        
        for (const comment of commentsResult.rows) {
          let commentLikesCount = 0;
          let commentUserLiked = false;
          try {
            const clResult = await db.query(`
              SELECT COUNT(*) as count FROM achievement_comment_likes WHERE comment_id = $1
            `, [comment.id]);
            commentLikesCount = parseInt(clResult.rows[0]?.count) || 0;
            
            const clUserResult = await db.query(`
              SELECT 1 FROM achievement_comment_likes WHERE comment_id = $1 AND user_id = $2
            `, [comment.id, viewerId]);
            commentUserLiked = clUserResult.rows.length > 0;
          } catch (e) { /* table may not exist */ }
          
          comments.push({
            ...comment,
            likes_count: commentLikesCount,
            user_liked: commentUserLiked
          });
        }
        
        commentsCount = comments.length;
      } catch (e) { /* table may not exist */ }
      
      reactions.push({
        achievement_id: ach.achievement_id,
        likes_count: likesCount,
        comments_count: commentsCount,
        user_liked: userLiked,
        comments: comments
      });
    }
    
    res.json(reactions);
  } catch (error) {
    console.error('Get achievement reactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on an achievement
router.post('/:id/achievements/:achievementId/like', authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const achievementId = req.params.achievementId;
    const likerId = req.user.id;
    
    const existingLike = await db.query(`
      SELECT id FROM achievement_likes WHERE owner_id = $1 AND achievement_id = $2 AND liker_id = $3
    `, [ownerId, achievementId, likerId]);
    
    let userLiked;
    if (existingLike.rows.length > 0) {
      await db.query(`DELETE FROM achievement_likes WHERE owner_id = $1 AND achievement_id = $2 AND liker_id = $3`, [ownerId, achievementId, likerId]);
      userLiked = false;
    } else {
      await db.query(`INSERT INTO achievement_likes (owner_id, achievement_id, liker_id) VALUES ($1, $2, $3)`, [ownerId, achievementId, likerId]);
      userLiked = true;
      
      // Create notification for owner
      await createNotification(ownerId, 'achievement_like', likerId, 'achievement', null, achievementId);
    }
    
    const countResult = await db.query(`SELECT COUNT(*) as count FROM achievement_likes WHERE owner_id = $1 AND achievement_id = $2`, [ownerId, achievementId]);
    
    res.json({
      likes_count: parseInt(countResult.rows[0]?.count) || 0,
      user_liked: userLiked
    });
  } catch (error) {
    console.error('Toggle achievement like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to an achievement
router.post('/:id/achievements/:achievementId/comment', authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const achievementId = req.params.achievementId;
    const authorId = req.user.id;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const result = await db.query(`
      INSERT INTO achievement_comments (owner_id, achievement_id, author_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, content, created_at
    `, [ownerId, achievementId, authorId, content.trim()]);
    
    const authorResult = await db.query(`SELECT username, avatar_base64 FROM users WHERE id = $1`, [authorId]);
    
    // Create notification for owner
    await createNotification(ownerId, 'achievement_comment', authorId, 'achievement', null, achievementId);
    
    res.json({
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      author_id: authorId,
      author_username: authorResult.rows[0]?.username,
      author_avatar: authorResult.rows[0]?.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    console.error('Add achievement comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on achievement comment
router.post('/:id/achievements/:achievementId/comments/:commentId/like', authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    const existingLike = await db.query(`
      SELECT id FROM achievement_comment_likes WHERE comment_id = $1 AND user_id = $2
    `, [commentId, userId]);
    
    let userLiked;
    if (existingLike.rows.length > 0) {
      await db.query(`DELETE FROM achievement_comment_likes WHERE comment_id = $1 AND user_id = $2`, [commentId, userId]);
      userLiked = false;
    } else {
      await db.query(`INSERT INTO achievement_comment_likes (comment_id, user_id) VALUES ($1, $2)`, [commentId, userId]);
      userLiked = true;
      
      // Create notification for comment author
      const comment = await db.query(`SELECT author_id FROM achievement_comments WHERE id = $1`, [commentId]);
      if (comment.rows[0]) {
        await createNotification(comment.rows[0].author_id, 'comment_like', userId, 'comment', parseInt(commentId), null);
      }
    }
    
    const countResult = await db.query(`SELECT COUNT(*) as count FROM achievement_comment_likes WHERE comment_id = $1`, [commentId]);
    
    res.json({
      likes_count: parseInt(countResult.rows[0]?.count) || 0,
      user_liked: userLiked
    });
  } catch (error) {
    console.error('Toggle achievement comment like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete achievement comment (only author can delete)
router.delete('/:id/achievements/:achievementId/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    const comment = await db.query(`SELECT author_id FROM achievement_comments WHERE id = $1`, [commentId]);
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    if (comment.rows[0].author_id !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    
    await db.query(`DELETE FROM achievement_comments WHERE id = $1`, [commentId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete achievement comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// NOTIFICATIONS
// ============================================================================

// Helper: Create or update grouped notification
async function createNotification(userId, type, actorId, targetType, targetId, targetName) {
  if (userId === actorId) return; // Don't notify yourself
  
  try {
    // Try to update existing group
    const existing = await db.query(`
      SELECT id, count FROM notification_groups 
      WHERE user_id = $1 AND type = $2 AND target_type = $3 AND target_id = $4
    `, [userId, type, targetType, targetId]);
    
    if (existing.rows.length > 0) {
      // Update existing group
      await db.query(`
        UPDATE notification_groups 
        SET count = count + 1, last_actor_id = $1, is_read = false, updated_at = NOW()
        WHERE id = $2
      `, [actorId, existing.rows[0].id]);
    } else {
      // Create new group
      await db.query(`
        INSERT INTO notification_groups (user_id, type, target_type, target_id, last_actor_id)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, type, targetType, targetId, actorId]);
    }
    
    // Also create individual notification for history
    await db.query(`
      INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, target_name)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, type, actorId, targetType, targetId, targetName]);
  } catch (e) {
    console.error('Create notification error:', e);
  }
}

// Helper: Notify followers about friend achievement/trick
async function notifyFollowers(userId, type, targetType, targetId, targetName) {
  try {
    // Get all users who have this user in their favorites
    const followers = await db.query(`
      SELECT user_id FROM favorites WHERE target_type = 'user' AND target_id = $1
    `, [userId]);
    
    for (const follower of followers.rows) {
      await createNotification(follower.user_id, type, userId, targetType, targetId, targetName);
    }
  } catch (e) {
    console.error('Notify followers error:', e);
  }
}

// GET /api/notifications - Get user's notifications
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get grouped notifications with actor info
    const result = await db.query(`
      SELECT 
        ng.id, ng.type, ng.target_type, ng.target_id, ng.count, ng.is_read, ng.created_at, ng.updated_at,
        u.id as actor_id, u.username as actor_username, u.avatar_base64 as actor_avatar,
        CASE 
          WHEN ng.target_type = 'trick' THEN (SELECT name FROM tricks WHERE id = ng.target_id)
          ELSE ng.target_id::TEXT
        END as target_name
      FROM notification_groups ng
      LEFT JOIN users u ON u.id = ng.last_actor_id
      WHERE ng.user_id = $1
      ORDER BY ng.updated_at DESC
      LIMIT 50
    `, [userId]);
    
    // Get unread count
    const unreadResult = await db.query(`
      SELECT COUNT(*) as count FROM notification_groups WHERE user_id = $1 AND is_read = false
    `, [userId]);
    
    res.json({
      notifications: result.rows,
      unread_count: parseInt(unreadResult.rows[0].count) || 0
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/notifications/count - Get unread count only
router.get('/notifications/count', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT COUNT(*) as count FROM notification_groups WHERE user_id = $1 AND is_read = false
    `, [req.user.id]);
    
    res.json({ unread_count: parseInt(result.rows[0].count) || 0 });
  } catch (error) {
    console.error('Get notification count error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/:id/read - Mark notification as read
router.post('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await db.query(`
      UPDATE notification_groups SET is_read = true WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/read-all - Mark all as read
router.post('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await db.query(`
      UPDATE notification_groups SET is_read = true WHERE user_id = $1
    `, [req.user.id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications/:id - Delete notification
router.delete('/notifications/:id', authMiddleware, async (req, res) => {
  try {
    await db.query(`
      DELETE FROM notification_groups WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications - Delete all notifications
router.delete('/notifications', authMiddleware, async (req, res) => {
  try {
    await db.query(`DELETE FROM notification_groups WHERE user_id = $1`, [req.user.id]);
    await db.query(`DELETE FROM notifications WHERE user_id = $1`, [req.user.id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete all notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
