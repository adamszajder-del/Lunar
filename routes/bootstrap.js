// Bootstrap Route - /api/bootstrap
// Perf #4: Combines 11 startup API calls into 1 request
// Saves ~10 round-trips and reduces DB connection contention

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { cache, TTL } = require('../utils/cache');
const { STATUS, ITEM_TYPE } = require('../utils/constants');
const log = require('../utils/logger');

// Import ACHIEVEMENTS for feed enrichment
let ACHIEVEMENTS = {};
try { ACHIEVEMENTS = require('./achievements').ACHIEVEMENTS; } catch(e) {}

router.get('/', authMiddleware, async (req, res) => {
  const t0 = Date.now();
  const userId = req.user.id;

  try {
    // ---------- ETAG: fast fingerprint check (avoids heavy queries if nothing changed) ----------
    const fpRes = await db.query(`
      SELECT
        (SELECT COALESCE(MAX(created_at), '1970-01-01') FROM tricks) as t_tricks,
        (SELECT COALESCE(MAX(created_at), '1970-01-01') FROM articles) as t_articles,
        (SELECT COALESCE(MAX(created_at), '1970-01-01') FROM events) as t_events,
        (SELECT COALESCE(MAX(created_at), '1970-01-01') FROM news) as t_news,
        (SELECT COALESCE(MAX(updated_at), '1970-01-01') FROM user_tricks WHERE user_id = $1) as t_progress,
        (SELECT COALESCE(MAX(updated_at), '1970-01-01') FROM user_articles WHERE user_id = $1) as t_articles_progress,
        (SELECT COUNT(*) FROM event_attendees WHERE user_id = $1) as c_reg,
        (SELECT COUNT(*) FROM favorites WHERE user_id = $1) as c_fav,
        (SELECT COUNT(*) FROM user_news_read WHERE user_id = $1) as c_read,
        (SELECT COALESCE(MAX(created_at), '1970-01-01') FROM user_achievements WHERE user_id = $1) as t_achievements,
        (SELECT COUNT(*) FROM products WHERE is_active = true) as c_products,
        (SELECT COUNT(*) FROM partners WHERE is_active = true) as c_partners,
        (SELECT COUNT(*) FROM parks WHERE is_active = true) as c_parks
    `, [userId]);

    const fp = fpRes.rows[0];
    const raw = [fp.t_tricks, fp.t_articles, fp.t_events, fp.t_news, fp.t_progress, fp.t_articles_progress, fp.c_reg, fp.c_fav, fp.c_read, fp.t_achievements, fp.c_products, fp.c_partners, fp.c_parks].join('|');
    
    // Simple hash (FNV-1a style, fast & deterministic)
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    const etag = `"bs-${hash.toString(36)}-${userId}"`;

    // If client sent If-None-Match and it matches → 304 Not Modified
    const clientEtag = req.headers['if-none-match'];
    if (clientEtag && clientEtag === etag) {
      const ms = Date.now() - t0;
      log.info('Bootstrap 304 (not modified)', { userId, ms });
      return res.status(304).end();
    }

    // Set ETag header for this response
    res.set('ETag', etag);
    // ---------- CATALOG DATA (cached, shared across users) ----------
    let tricks = cache.get('tricks:all');
    let articles = cache.get('articles:1:500');
    let products = cache.get('products:1:500');
    let partners = cache.get('partners:all');
    let parks = cache.get('parks:all');

    const catalogQueries = [];
    if (!tricks) catalogQueries.push(
      db.query('SELECT id, public_id, name, category, difficulty, description, video_url, image_url, position, created_at FROM tricks ORDER BY category, difficulty')
        .then(r => { tricks = r.rows; cache.set('tricks:all', tricks, TTL.CATALOG); })
    );
    if (!articles) catalogQueries.push(
      db.query(`SELECT a.id, a.public_id, a.category, a.title, a.description, a.read_time, a.image_url, a.author_id, a.created_at, u.username as author_username FROM articles a LEFT JOIN users u ON a.author_id = u.id ORDER BY a.category, a.created_at DESC`)
        .then(r => { articles = r.rows; cache.set('articles:1:500', articles, TTL.CATALOG); })
    );
    if (!products) catalogQueries.push(
      db.query(`SELECT * FROM products WHERE is_active = true ORDER BY category, name`)
        .then(r => { products = r.rows; cache.set('products:1:500', products, TTL.CATALOG); })
    );
    if (!partners) catalogQueries.push(
      db.query(`SELECT * FROM partners WHERE is_active = true ORDER BY position ASC, name ASC`)
        .then(r => { partners = r.rows; cache.set('partners:all', partners, TTL.CATALOG); })
    );
    if (!parks) catalogQueries.push(
      db.query(`SELECT * FROM parks WHERE is_active = true ORDER BY position ASC, name ASC`)
        .then(r => { parks = r.rows; cache.set('parks:all', parks, TTL.CATALOG); })
    );

    // Crew — cached 60s (same data for all users, heaviest shared query)
    let crew = cache.get('crew:all');

    // ---------- ALL QUERIES IN PARALLEL ----------
    const [
      _catalogs,
      eventsRes,
      crewRes,
      progressRes,
      registeredRes,
      bookingsRes,
      newsRes,
      articleProgressRes,
      favoritesRes,
      notifCountRes,
      feedRes,
      feedHiddenRes
    ] = await Promise.all([
      // Catalog cache fills (may be empty array if all cached)
      Promise.all(catalogQueries),

      // Events (short cache — attendees change)
      db.query(`
        SELECT e.*, 
               u.username as creator_username, u.id as creator_id, u.avatar_base64 as creator_avatar, u.country_flag as creator_country_flag,
               COALESCE(ea_count.attendees, 0) as attendees
        FROM events e
        LEFT JOIN users u ON e.author_id = u.id
        LEFT JOIN (
          SELECT event_id, COUNT(*) as attendees FROM event_attendees GROUP BY event_id
        ) ea_count ON ea_count.event_id = e.id
        ORDER BY e.date, e.time
      `),

      // Crew — lightweight cards (no avatar_base64, no stats JOINs), cached 60s
      // Avatars served via GET /api/users/:id/avatar (cacheable, lazy-loaded)
      crew ? Promise.resolve({ rows: crew }) :
      db.query(`
        SELECT 
          u.id, u.public_id, u.username, u.display_name, u.created_at,
          COALESCE(u.is_coach, false) as is_coach, 
          COALESCE(u.is_staff, false) as is_staff,
          COALESCE(u.is_club_member, false) as is_club_member,
          u.role, u.country_flag
        FROM users u
        WHERE (u.is_approved = true OR u.is_approved IS NULL) AND u.is_admin = false
        ORDER BY u.is_coach DESC NULLS LAST, u.username
      `),

      // User trick progress
      db.query('SELECT trick_id, status, COALESCE(goofy_status, \'todo\') as goofy_status, notes FROM user_tricks WHERE user_id = $1', [userId]),

      // Registered events
      db.query('SELECT event_id FROM event_attendees WHERE user_id = $1', [userId]),

      // Bookings
      db.query(`
        SELECT id, public_id, product_name, product_category, booking_date, booking_time, status, amount, created_at,
               UPPER(SUBSTRING(public_id FROM POSITION('-' IN public_id) + 1)) as confirmation_code
        FROM orders WHERE user_id = $1 AND booking_date IS NOT NULL AND status IN ('completed', 'pending_shipment')
        ORDER BY booking_date ASC
      `, [userId]),

      // News with read status
      db.query(`
        SELECT n.*, CASE WHEN unr.id IS NOT NULL THEN true ELSE false END as is_read, unr.read_at
        FROM news n
        LEFT JOIN user_news_read unr ON n.id = unr.news_id AND unr.user_id = $1
        WHERE NOT EXISTS (SELECT 1 FROM user_news_hidden unh WHERE unh.news_id = n.id AND unh.user_id = $1)
        ORDER BY n.created_at DESC
      `, [userId]),

      // Article progress
      db.query('SELECT article_id, status FROM user_articles WHERE user_id = $1', [userId]),

      // Favorites
      db.query('SELECT item_type, item_id FROM favorites WHERE user_id = $1', [userId]),

      // Notification count
      db.query('SELECT COUNT(*) as count FROM notification_groups WHERE user_id = $1 AND is_read = false', [userId]),

      // Feed (initial 10 items — PERF: no avatar in CTEs, filtered aggregates, late avatar JOIN)
      db.query(`
        WITH followed AS (
          SELECT item_id as user_id FROM favorites WHERE user_id = $1 AND item_type = 'user'
          UNION SELECT $1
        ),
        trick_feed AS (
          SELECT 
            CASE WHEN ut.status = 'mastered' THEN 'trick_mastered' ELSE 'trick_started' END as type,
            ut.user_id, ut.trick_id, NULL::integer as event_id, NULL::text as achievement_id,
            COALESCE(ut.updated_at, NOW()) as created_at,
            json_build_object('trick_id', t.id, 'trick_name', t.name, 'category', t.category) as data,
            u.username, u.display_name, u.is_coach, u.is_staff, u.is_club_member, u.country_flag,
            COALESCE(likes.count, 0) as likes_count,
            COALESCE(comments.count, 0) as comments_count,
            CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked
          FROM user_tricks ut
          JOIN tricks t ON ut.trick_id = t.id
          JOIN users u ON ut.user_id = u.id
          LEFT JOIN (SELECT owner_id, trick_id, COUNT(*) as count FROM trick_likes WHERE owner_id IN (SELECT user_id FROM followed) GROUP BY owner_id, trick_id) likes 
            ON likes.owner_id = ut.user_id AND likes.trick_id = ut.trick_id
          LEFT JOIN (SELECT owner_id, trick_id, COUNT(*) as count FROM trick_comments WHERE (is_deleted IS NULL OR is_deleted = false) AND owner_id IN (SELECT user_id FROM followed) GROUP BY owner_id, trick_id) comments 
            ON comments.owner_id = ut.user_id AND comments.trick_id = ut.trick_id
          LEFT JOIN trick_likes user_like ON user_like.owner_id = ut.user_id AND user_like.trick_id = ut.trick_id AND user_like.liker_id = $1
          WHERE ut.user_id IN (SELECT user_id FROM followed) AND (ut.status IN ('mastered', 'in_progress') OR COALESCE(ut.goofy_status, 'todo') IN ('mastered', 'in_progress'))
        ),
        event_feed AS (
          SELECT 'event_joined' as type, ea.user_id, NULL::integer as trick_id, ea.event_id, NULL::text as achievement_id,
            COALESCE(ea.registered_at, NOW()) as created_at,
            json_build_object('event_id', e.id, 'event_title', e.name, 'event_date', e.date, 'event_time', e.time,
              'event_location', e.location, 'event_spots', e.spots,
              'event_attendees', COALESCE(ea_count.count, 0),
              'event_creator', creator.display_name, 'event_creator_username', creator.username) as data,
            u.username, u.display_name, u.is_coach, u.is_staff, u.is_club_member, u.country_flag,
            0::bigint as likes_count, 0::bigint as comments_count, false as user_liked
          FROM event_attendees ea
          JOIN events e ON ea.event_id = e.id
          JOIN users u ON ea.user_id = u.id
          LEFT JOIN users creator ON e.author_id = creator.id
          LEFT JOIN (SELECT event_id, COUNT(*) as count FROM event_attendees GROUP BY event_id) ea_count ON ea_count.event_id = e.id
          WHERE ea.user_id IN (SELECT user_id FROM followed)
        ),
        achievement_feed AS (
          SELECT 'achievement_earned' as type, ua.user_id, NULL::integer as trick_id, NULL::integer as event_id,
            ua.achievement_id,
            COALESCE(ua.achieved_at, NOW()) as created_at,
            json_build_object('achievement_id', ua.achievement_id, 'achievement_name', ua.achievement_id, 'tier', ua.tier, 'icon', ua.achievement_id) as data,
            u.username, u.display_name, u.is_coach, u.is_staff, u.is_club_member, u.country_flag,
            COALESCE(likes.count, 0) as likes_count,
            COALESCE(comments.count, 0) as comments_count,
            CASE WHEN user_like.id IS NOT NULL THEN true ELSE false END as user_liked
          FROM user_achievements ua
          JOIN users u ON ua.user_id = u.id
          LEFT JOIN (SELECT owner_id, achievement_id, COUNT(*) as count FROM achievement_likes WHERE owner_id IN (SELECT user_id FROM followed) GROUP BY owner_id, achievement_id) likes 
            ON likes.owner_id = ua.user_id AND likes.achievement_id = ua.achievement_id
          LEFT JOIN (SELECT owner_id, achievement_id, COUNT(*) as count FROM achievement_comments WHERE (is_deleted IS NULL OR is_deleted = false) AND owner_id IN (SELECT user_id FROM followed) GROUP BY owner_id, achievement_id) comments 
            ON comments.owner_id = ua.user_id AND comments.achievement_id = ua.achievement_id
          LEFT JOIN achievement_likes user_like ON user_like.owner_id = ua.user_id AND user_like.achievement_id = ua.achievement_id AND user_like.liker_id = $1
          WHERE ua.user_id IN (SELECT user_id FROM followed)
        )
        SELECT combined.*, u_av.avatar_base64
        FROM (
          SELECT * FROM trick_feed UNION ALL SELECT * FROM event_feed UNION ALL SELECT * FROM achievement_feed
        ) combined
        LEFT JOIN users u_av ON u_av.id = combined.user_id
        ORDER BY created_at DESC NULLS LAST LIMIT 11
      `, [userId]),

      // Feed hidden items (for filtering)
      db.query('SELECT feed_item_id FROM feed_hidden WHERE user_id = $1', [userId]),
    ]);

    // ---------- FORMAT RESPONSE ----------
    const progress = {};
    progressRes.rows.forEach(row => { progress[row.trick_id] = { status: row.status, goofy_status: row.goofy_status, notes: row.notes }; });

    // Cache crew if it was freshly queried
    if (!crew) {
      crew = crewRes.rows;
      cache.set('crew:all', crew, TTL.CREW);
    }

    const favRows = favoritesRes.rows;
    const favorites = {
      tricks: favRows.filter(f => f.item_type === ITEM_TYPE.TRICK).map(f => f.item_id),
      articles: favRows.filter(f => f.item_type === ITEM_TYPE.ARTICLE).map(f => f.item_id),
      users: favRows.filter(f => f.item_type === ITEM_TYPE.USER).map(f => f.item_id)
    };

    const news = newsRes.rows;
    const unreadNewsCount = news.filter(n => !n.is_read).length;
    const notifUnread = parseInt(notifCountRes.rows[0].count) || 0;

    // Format feed items (same logic as /api/feed) — filter hidden
    const feedHiddenIds = new Set(feedHiddenRes.rows.map(r => r.feed_item_id));
    const feedLimit = 10;
    const allFeedItems = feedRes.rows.map(row => {
      let data = row.data;
      if (row.type === 'achievement_earned' && row.achievement_id && ACHIEVEMENTS[row.achievement_id]) {
        const achDef = ACHIEVEMENTS[row.achievement_id];
        data = { ...data, achievement_name: achDef.name, icon: achDef.icon, tiers: achDef.tiers, description: achDef.description };
      }
      return {
        id: row.trick_id ? `${row.type}_${row.user_id}_${row.trick_id}` 
          : row.event_id ? `${row.type}_${row.user_id}_${row.event_id}` 
          : `${row.type}_${row.user_id}_${row.achievement_id}`,
        type: row.type, created_at: row.created_at, data,
        user: { id: row.user_id, username: row.username, display_name: row.display_name, avatar_base64: row.avatar_base64, is_coach: row.is_coach, is_staff: row.is_staff, is_club_member: row.is_club_member, country_flag: row.country_flag },
        owner_id: row.user_id, trick_id: row.trick_id, event_id: row.event_id, achievement_id: row.achievement_id,
        reactions_count: parseInt(row.likes_count) || 0, user_reacted: row.user_liked, comments_count: parseInt(row.comments_count) || 0
      };
    });
    const filteredFeed = feedHiddenIds.size > 0 ? allFeedItems.filter(item => !feedHiddenIds.has(item.id)) : allFeedItems;
    const feedHasMore = filteredFeed.length > feedLimit;
    const feedItems = filteredFeed.slice(0, feedLimit);

    const ms = Date.now() - t0;
    log.info('Bootstrap loaded', { userId, ms, cached: tricks === cache.get('tricks:all') ? 'yes' : 'no' });

    res.json({
      tricks,
      progress,
      events: eventsRes.rows,
      registeredEvents: registeredRes.rows.map(r => r.event_id),
      bookings: bookingsRes.rows,
      news,
      crew,
      articles,
      articleProgress: articleProgressRes.rows,
      products,
      partners,
      parks,
      favorites,
      unreadCount: Math.min(notifUnread + unreadNewsCount, 99),
      feed: { items: feedItems, hasMore: feedHasMore },
      _meta: { ms, cached: catalogQueries.length === 0 }
    });

  } catch (error) {
    log.error('Bootstrap error', { error, userId });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
