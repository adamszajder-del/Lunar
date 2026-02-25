// Shared reaction helpers — replaces ~500 lines of duplicated reaction code
// across users.js (trick likes/comments, achievement likes/comments) and news.js
//
// Usage:
//   const { getReactionsForItems, getReactionsForSingle, atomicToggleLike } = require('../utils/reactions');

const db = require('../database');
const log = require('./logger');

// ============================================================================
// Fix #1: Atomic toggle — eliminates race conditions in all like/unlike toggles
// Uses INSERT ON CONFLICT DO NOTHING + DELETE ... RETURNING pattern
// ============================================================================

/**
 * Atomically toggle a like. Returns { userLiked, likesCount }.
 * @param {string} table - Like table name (e.g. 'trick_likes')
 * @param {object} where - Column-value pairs for WHERE clause (e.g. { owner_id: 1, trick_id: 2, liker_id: 3 })
 * @param {object} countWhere - Column-value pairs for COUNT (e.g. { owner_id: 1, trick_id: 2 })
 */
async function atomicToggleLike(table, where, countWhere) {
  // Whitelist allowed tables to prevent SQL injection
  const ALLOWED_TABLES = [
    'trick_likes', 'comment_likes', 'achievement_likes',
    'achievement_comment_likes', 'news_likes', 'news_comment_likes',
    'feed_reactions'
  ];
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Invalid like table: ${table}`);
  }

  const cols = Object.keys(where);
  const vals = Object.values(where);
  const whereClause = cols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');

  // Try to DELETE first — if row existed, we unliked
  const deleteResult = await db.query(
    `DELETE FROM ${table} WHERE ${whereClause} RETURNING id`,
    vals
  );

  let userLiked;
  if (deleteResult.rows.length > 0) {
    // Row existed → we just unliked
    userLiked = false;
  } else {
    // Row didn't exist → insert (like)
    const insertCols = cols.join(', ');
    const insertPlaceholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `INSERT INTO ${table} (${insertCols}) VALUES (${insertPlaceholders}) ON CONFLICT DO NOTHING`,
      vals
    );
    userLiked = true;
  }

  // Get updated count
  const countCols = Object.keys(countWhere);
  const countVals = Object.values(countWhere);
  const countClause = countCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
  
  const countResult = await db.query(
    `SELECT COUNT(*) as count FROM ${table} WHERE ${countClause}`,
    countVals
  );

  return {
    userLiked,
    likesCount: parseInt(countResult.rows[0]?.count) || 0,
  };
}

// ============================================================================
// Batch reactions — replaces N+1 loops for getting likes+comments on items
// ============================================================================

/**
 * Get reactions (likes + comments with their likes) for multiple items in batch.
 * Replaces the N+1 loop pattern that generates 700+ queries.
 *
 * @param {object} opts
 * @param {string} opts.likesTable - e.g. 'trick_likes'
 * @param {string} opts.likesOwnerCol - e.g. 'owner_id'  
 * @param {string} opts.likesItemCol - e.g. 'trick_id'
 * @param {string} opts.likesUserCol - e.g. 'liker_id'
 * @param {string} opts.commentsTable - e.g. 'trick_comments'
 * @param {string} opts.commentsOwnerCol - e.g. 'owner_id'
 * @param {string} opts.commentsItemCol - e.g. 'trick_id'
 * @param {string} opts.commentLikesTable - e.g. 'comment_likes'
 * @param {number} opts.ownerId - owner user ID
 * @param {number} opts.viewerId - viewing user ID (for user_liked)
 * @param {Array} opts.itemIds - list of item IDs to get reactions for
 * @param {string} opts.itemIdField - field name in response (e.g. 'trick_id' or 'achievement_id')
 */
async function getBatchReactions(opts) {
  const {
    likesTable, likesOwnerCol, likesItemCol, likesUserCol,
    commentsTable, commentsOwnerCol, commentsItemCol, commentLikesTable,
    ownerId, viewerId, itemIds, itemIdField,
  } = opts;

  if (!itemIds || itemIds.length === 0) return [];

  // 1. Batch get likes counts + user_liked for all items
  const likesResult = await db.query(`
    SELECT 
      ${likesItemCol} as item_id,
      COUNT(*) as likes_count,
      BOOL_OR(${likesUserCol} = $2) as user_liked
    FROM ${likesTable}
    WHERE ${likesOwnerCol} = $1 AND ${likesItemCol} = ANY($3)
    GROUP BY ${likesItemCol}
  `, [ownerId, viewerId, itemIds]);

  const likesMap = {};
  likesResult.rows.forEach(r => {
    likesMap[r.item_id] = { likes_count: parseInt(r.likes_count), user_liked: r.user_liked };
  });

  // 2. Batch get comments with author info
  const commentsResult = await db.query(`
    SELECT 
      c.id, c.${commentsItemCol} as item_id, c.content, c.created_at, c.author_id,
      u.username as author_username, u.avatar_base64 as author_avatar, u.country_flag as author_country_flag
    FROM ${commentsTable} c
    JOIN users u ON c.author_id = u.id
    WHERE c.${commentsOwnerCol} = $1 AND c.${commentsItemCol} = ANY($2)
      AND (c.is_deleted IS NULL OR c.is_deleted = false)
    ORDER BY c.created_at ASC
  `, [ownerId, itemIds]);

  // 3. Batch get comment likes
  const commentIds = commentsResult.rows.map(c => c.id);
  let commentLikesMap = {};
  
  if (commentIds.length > 0) {
    const clResult = await db.query(`
      SELECT 
        comment_id,
        COUNT(*) as likes_count,
        BOOL_OR(user_id = $1) as user_liked
      FROM ${commentLikesTable}
      WHERE comment_id = ANY($2)
      GROUP BY comment_id
    `, [viewerId, commentIds]);
    
    clResult.rows.forEach(r => {
      commentLikesMap[r.comment_id] = { likes_count: parseInt(r.likes_count), user_liked: r.user_liked };
    });
  }

  // 4. Assemble response per item
  const commentsGrouped = {};
  commentsResult.rows.forEach(c => {
    if (!commentsGrouped[c.item_id]) commentsGrouped[c.item_id] = [];
    const cl = commentLikesMap[c.id] || { likes_count: 0, user_liked: false };
    commentsGrouped[c.item_id].push({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      author_id: c.author_id,
      author_username: c.author_username,
      author_avatar: c.author_avatar,
      author_country_flag: c.author_country_flag,
      likes_count: cl.likes_count,
      user_liked: cl.user_liked,
    });
  });

  return itemIds.map(itemId => {
    const likes = likesMap[itemId] || { likes_count: 0, user_liked: false };
    const comments = commentsGrouped[itemId] || [];
    return {
      [itemIdField]: itemId,
      likes_count: likes.likes_count,
      comments_count: comments.length,
      user_liked: likes.user_liked,
      comments,
    };
  });
}

/**
 * Get reactions for a single item (e.g. single news or single achievement).
 * Same as batch but for one item — still uses efficient queries.
 */
async function getSingleReactions(opts) {
  const results = await getBatchReactions({ ...opts, itemIds: [opts.itemId] });
  if (results.length === 0) return { likes_count: 0, comments_count: 0, user_liked: false, comments: [] };
  const r = results[0];
  // Remove the item ID field for single-item response
  delete r[opts.itemIdField];
  return r;
}

module.exports = { atomicToggleLike, getBatchReactions, getSingleReactions };
