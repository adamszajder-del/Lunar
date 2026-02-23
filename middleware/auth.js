// Authentication Middleware
const jwt = require('jsonwebtoken');
const db = require('../database');
const config = require('../config');
const log = require('../utils/logger');
const { isBlacklisted, isUserForceLoggedOut } = require('../utils/tokenBlacklist');

// ============================================================================
// Fix PERF-CRIT-1: Removed COUNT(*) subquery that ran on EVERY request
// Fix PERF-HIGH-1: User cache (60s TTL) — avatar_base64 loaded once, not per-request
// ============================================================================
const userCache = new Map();
const USER_CACHE_TTL = 60000; // 60 seconds

// Invalidate cache for a specific user (call on block, password change, role change)
const invalidateUserCache = (userId) => {
  userCache.delete(Number(userId));
};

// Cleanup stale cache entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache) {
    if (now - entry.ts > USER_CACHE_TTL) userCache.delete(key);
  }
}, 5 * 60 * 1000);

// Auth middleware - checks Authorization header and validates user status
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, config.JWT_SECRET);
    
    if (!decoded.userId) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    // Check token blacklist (session revocation)
    if (decoded.jti && isBlacklisted(decoded.jti)) {
      return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
    }

    // Check if user was force-logged-out after this token was issued
    if (isUserForceLoggedOut(decoded.userId, decoded.iat)) {
      return res.status(401).json({ error: 'Session revoked by administrator', code: 'FORCE_LOGOUT' });
    }

    // Check cache first
    let user;
    const cached = userCache.get(decoded.userId);
    if (cached && Date.now() - cached.ts < USER_CACHE_TTL) {
      user = cached.user;
    } else {
      // Cache miss — query DB (no avatar_base64 — served via /api/users/:id/avatar)
      let result;
      try {
        result = await db.query(`
          SELECT id, public_id, email, username, display_name, role,
                 is_admin, is_blocked, created_at,
                 COALESCE(is_coach, false) as is_coach,
                 COALESCE(is_staff, false) as is_staff,
                 COALESCE(is_club_member, false) as is_club_member,
                 password_changed_at
          FROM users WHERE id = $1
        `, [decoded.userId]);
      } catch (queryErr) {
        result = await db.query(`
          SELECT id, public_id, email, username, display_name, role,
                 is_admin, created_at,
                 COALESCE(is_blocked, false) as is_blocked,
                 COALESCE(is_coach, false) as is_coach,
                 COALESCE(is_staff, false) as is_staff,
                 COALESCE(is_club_member, false) as is_club_member,
                 NULL as password_changed_at
          FROM users WHERE id = $1
        `, [decoded.userId]);
      }

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User not found' });
      }

      user = result.rows[0];
      userCache.set(decoded.userId, { user, ts: Date.now() });
    }
    
    // Check if user is blocked (always checked, even from cache)
    if (user.is_blocked) {
      invalidateUserCache(decoded.userId);
      return res.status(403).json({ error: 'Account blocked', code: 'ACCOUNT_BLOCKED' });
    }
    
    // Check if password was changed after token was issued
    if (user.password_changed_at && decoded.iat) {
      const passwordChangedTimestamp = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
      if (decoded.iat < passwordChangedTimestamp) {
        invalidateUserCache(decoded.userId);
        return res.status(401).json({ error: 'Token expired due to password change', code: 'PASSWORD_CHANGED' });
      }
    }

    req.user = user;
    req.tokenInfo = { jti: decoded.jti, iat: decoded.iat, exp: decoded.exp };
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// Admin check middleware (use after authMiddleware)
const adminMiddleware = (req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Coach check middleware
const coachMiddleware = (req, res, next) => {
  if (!req.user || (!req.user.is_admin && !req.user.is_coach)) {
    return res.status(403).json({ error: 'Coach access required' });
  }
  next();
};

// Staff check middleware
const staffMiddleware = (req, res, next) => {
  if (!req.user || (!req.user.is_admin && !req.user.is_staff && !req.user.is_coach)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  coachMiddleware,
  staffMiddleware,
  invalidateUserCache
};
