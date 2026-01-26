// Rate Limiting Middleware
const config = require('../config');

// In-memory store for login attempts
const loginAttempts = new Map();

// Cleanup old entries periodically
const cleanupRateLimiter = () => {
  const now = Date.now();
  for (const [key, data] of loginAttempts) {
    if (now - data.firstAttempt > config.RATE_LIMIT_WINDOW) {
      loginAttempts.delete(key);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);

// Check if IP is rate limited
const checkRateLimit = (ip) => {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  
  if (!data) return { allowed: true, remaining: config.MAX_LOGIN_ATTEMPTS };
  
  if (now - data.firstAttempt > config.RATE_LIMIT_WINDOW) {
    loginAttempts.delete(ip);
    return { allowed: true, remaining: config.MAX_LOGIN_ATTEMPTS };
  }
  
  const remaining = config.MAX_LOGIN_ATTEMPTS - data.attempts;
  return { 
    allowed: data.attempts < config.MAX_LOGIN_ATTEMPTS, 
    remaining: Math.max(0, remaining),
    resetIn: Math.ceil((config.RATE_LIMIT_WINDOW - (now - data.firstAttempt)) / 1000 / 60)
  };
};

// Record a login attempt
const recordLoginAttempt = (ip, success) => {
  if (success) {
    loginAttempts.delete(ip);
    return;
  }
  const now = Date.now();
  const data = loginAttempts.get(ip);
  if (!data) {
    loginAttempts.set(ip, { attempts: 1, firstAttempt: now });
  } else {
    data.attempts++;
  }
};

// Get client IP from request
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.ip || 
         req.connection?.remoteAddress || 
         'unknown';
};

module.exports = {
  checkRateLimit,
  recordLoginAttempt,
  getClientIP
};
