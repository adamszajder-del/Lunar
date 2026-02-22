// Token Blacklist — Session Revocation
// In-memory Set for fast lookup + DB persistence across restarts
// Tokens auto-expire based on their JWT expiry (no manual cleanup needed)

const db = require('../database');
const log = require('./logger');

// In-memory blacklist for O(1) lookup per request
const blacklist = new Set();
let tableReady = false;

const ensureTable = async () => {
  if (tableReady) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS token_blacklist (
        jti VARCHAR(36) PRIMARY KEY,
        user_id INTEGER,
        reason VARCHAR(50) DEFAULT 'logout',
        blacklisted_by INTEGER,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_blacklist_user ON token_blacklist(user_id)`);
    tableReady = true;
  } catch (e) {
    tableReady = true; // table likely exists
  }
};

/**
 * Load active blacklisted tokens into memory (call on startup)
 */
const loadBlacklist = async () => {
  try {
    await ensureTable();
    const result = await db.query(
      'SELECT jti FROM token_blacklist WHERE expires_at > NOW()'
    );
    result.rows.forEach(row => blacklist.add(row.jti));
    log.info(`Token blacklist loaded: ${result.rows.length} active entries`);
  } catch (e) {
    log.error('Failed to load token blacklist:', e.message);
  }
};

/**
 * Check if a token JTI is blacklisted (O(1) in-memory check)
 * @param {string} jti
 * @returns {boolean}
 */
const isBlacklisted = (jti) => {
  if (!jti) return false;
  return blacklist.has(jti);
};

/**
 * Blacklist a single token
 * @param {string} jti - JWT ID
 * @param {number} userId - user who owns the token
 * @param {Date} expiresAt - when the JWT expires (blacklist entry auto-cleans after)
 * @param {string} reason - 'logout' | 'force_logout' | 'password_change' | 'blocked'
 * @param {number|null} blacklistedBy - admin user ID (null for self-logout)
 */
const addToBlacklist = async (jti, userId, expiresAt, reason = 'logout', blacklistedBy = null) => {
  if (!jti) return;
  
  // Immediately block in memory
  blacklist.add(jti);
  
  // Persist to DB (async, non-blocking)
  try {
    await ensureTable();
    await db.query(
      `INSERT INTO token_blacklist (jti, user_id, reason, blacklisted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, userId, reason, blacklistedBy, new Date(expiresAt * 1000)]
    );
  } catch (e) {
    log.error('Failed to persist blacklist entry:', e.message);
    // Token is still blocked in memory for this instance
  }
};

/**
 * Blacklist ALL active tokens for a user (force logout everywhere)
 * Since we can't enumerate all JTIs, this adds a marker that auth middleware checks
 * @param {number} userId
 * @param {string} reason
 * @param {number|null} blacklistedBy
 */
const blacklistUser = async (userId, reason = 'force_logout', blacklistedBy = null) => {
  try {
    await ensureTable();
    // Insert a special "all tokens" marker with user_id
    // Auth middleware checks this via DB when jti is not in memory blacklist
    await db.query(
      `INSERT INTO token_blacklist (jti, user_id, reason, blacklisted_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '4 hours')
       ON CONFLICT (jti) DO NOTHING`,
      ['all_' + userId + '_' + Date.now(), userId, reason, blacklistedBy]
    );
    // Also set a flag we can check quickly
    userForceLogoutTimestamps.set(userId, Math.floor(Date.now() / 1000));
  } catch (e) {
    log.error('Failed to blacklist user tokens:', e.message);
  }
};

// Track force-logout timestamps per user (for checking tokens issued before force-logout)
const userForceLogoutTimestamps = new Map();

/**
 * Check if a user's token was issued before a force-logout
 * @param {number} userId
 * @param {number} iat - token issued-at timestamp
 * @returns {boolean}
 */
const isUserForceLoggedOut = (userId, iat) => {
  const forceLogoutAt = userForceLogoutTimestamps.get(userId);
  if (!forceLogoutAt) return false;
  return iat < forceLogoutAt;
};

/**
 * Load force-logout timestamps on startup
 */
const loadForceLogouts = async () => {
  try {
    await ensureTable();
    const result = await db.query(
      `SELECT user_id, MAX(EXTRACT(EPOCH FROM created_at)::INTEGER) as forced_at
       FROM token_blacklist 
       WHERE reason IN ('force_logout', 'blocked') AND expires_at > NOW()
       GROUP BY user_id`
    );
    result.rows.forEach(row => {
      userForceLogoutTimestamps.set(row.user_id, row.forced_at);
    });
    log.info(`Force-logout timestamps loaded: ${result.rows.length} users`);
  } catch (e) {
    // Non-critical on startup
  }
};

/**
 * Cleanup expired entries (run periodically)
 */
const cleanup = async () => {
  try {
    await ensureTable();
    const result = await db.query(
      'DELETE FROM token_blacklist WHERE expires_at < NOW()'
    );
    // Also clean in-memory (we can't easily map jti→expiry, so reload)
    if (result.rowCount > 0) {
      blacklist.clear();
      const active = await db.query('SELECT jti FROM token_blacklist WHERE expires_at > NOW()');
      active.rows.forEach(row => blacklist.add(row.jti));
    }
    // Clean old force-logout timestamps (older than 4h)
    const cutoff = Math.floor(Date.now() / 1000) - (4 * 3600);
    for (const [userId, ts] of userForceLogoutTimestamps) {
      if (ts < cutoff) userForceLogoutTimestamps.delete(userId);
    }
  } catch (e) {
    // Non-critical
  }
};

// Cleanup every 30 minutes
setInterval(cleanup, 30 * 60 * 1000);

module.exports = {
  loadBlacklist,
  loadForceLogouts,
  isBlacklisted,
  isUserForceLoggedOut,
  addToBlacklist,
  blacklistUser,
  cleanup,
};
