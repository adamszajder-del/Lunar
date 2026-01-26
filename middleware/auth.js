// Authentication Middleware
const jwt = require('jsonwebtoken');
const db = require('../database');
const config = require('../config');

// Auth middleware - checks Authorization header and validates user status
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('Auth failed: No token provided for', req.path);
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, config.JWT_SECRET);
    
    // Check token has required fields
    if (!decoded.userId) {
      console.log('Auth failed: Invalid token format for', req.path);
      return res.status(401).json({ error: 'Invalid token format' });
    }
    
    // Query without password_changed_at if column doesn't exist
    let result;
    try {
      result = await db.query(`
        SELECT id, public_id, email, username, display_name, avatar_base64, role,
               is_admin, is_blocked,
               COALESCE(is_coach, false) as is_coach,
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               password_changed_at,
               (SELECT COUNT(*) FROM user_tricks WHERE user_id = users.id AND status = 'mastered') as mastered
        FROM users WHERE id = $1
      `, [decoded.userId]);
    } catch (queryErr) {
      // Fallback without password_changed_at column
      result = await db.query(`
        SELECT id, public_id, email, username, display_name, avatar_base64, role,
               is_admin, 
               COALESCE(is_blocked, false) as is_blocked,
               COALESCE(is_coach, false) as is_coach,
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               NULL as password_changed_at,
               0 as mastered
        FROM users WHERE id = $1
      `, [decoded.userId]);
    }
    
    if (result.rows.length === 0) {
      console.log('Auth failed: User not found for ID', decoded.userId);
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    
    // Check if user is blocked
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Account blocked', code: 'ACCOUNT_BLOCKED' });
    }
    
    // Check if password was changed after token was issued (optional security)
    if (user.password_changed_at && decoded.iat) {
      const passwordChangedTimestamp = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
      if (decoded.iat < passwordChangedTimestamp) {
        return res.status(401).json({ error: 'Token expired due to password change', code: 'PASSWORD_CHANGED' });
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.log('Auth error for', req.path, ':', error.name, error.message);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
    res.status(401).json({ error: 'Authentication failed', details: error.message });
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
  if (!req.user || (!req.user.is_admin && !req.user.is_staff)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  coachMiddleware,
  staffMiddleware
};
