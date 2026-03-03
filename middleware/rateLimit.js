// Rate Limiting Middleware
const config = require('../config');

// In-memory store for login attempts
const loginAttempts = new Map();

// Generic rate limiter store (keyed by prefix:ip)
const rateLimitStore = new Map();

// Cleanup old entries periodically
const cleanupRateLimiter = () => {
  const now = Date.now();
  for (const [key, data] of loginAttempts) {
    if (now - data.firstAttempt > config.RATE_LIMIT_WINDOW) {
      loginAttempts.delete(key);
    }
  }
  for (const [key, data] of rateLimitStore) {
    if (now - data.windowStart > data.windowMs) {
      rateLimitStore.delete(key);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);

// Check if IP is rate limited (login-specific)
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
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.ip || 
         req.connection?.remoteAddress || 
         'unknown';
};

// Generic rate limiter middleware factory
// Usage: app.use('/api/rfid/scan', createRateLimiter({ maxRequests: 30, windowMs: 60000 }))
const createRateLimiter = ({ prefix = 'rl', maxRequests = 60, windowMs = 60000 } = {}) => {
  return (req, res, next) => {
    const ip = getClientIP(req);
    const key = `${prefix}:${ip}`;
    const now = Date.now();
    
    let data = rateLimitStore.get(key);
    
    if (!data || now - data.windowStart > windowMs) {
      data = { count: 1, windowStart: now, windowMs };
      rateLimitStore.set(key, data);
      return next();
    }
    
    data.count++;
    
    if (data.count > maxRequests) {
      const resetIn = Math.ceil((windowMs - (now - data.windowStart)) / 1000);
      res.setHeader('Retry-After', resetIn);
      return res.status(429).json({ 
        error: 'Too many requests. Please try again later.',
        retryAfter: resetIn
      });
    }
    
    next();
  };
};

// Per-account rate limiter — keyed by user ID (requires authMiddleware to run first)
// Usage: router.get('/feed', authMiddleware, createAccountRateLimiter({ maxRequests: 30 }), handler)
const createAccountRateLimiter = ({ prefix = 'acct', maxRequests = 60, windowMs = 60000 } = {}) => {
  return (req, res, next) => {
    // Skip if no authenticated user (let authMiddleware handle that)
    if (!req.user || !req.user.id) return next();
    
    const key = `${prefix}:u:${req.user.id}`;
    const now = Date.now();
    
    let data = rateLimitStore.get(key);
    
    if (!data || now - data.windowStart > windowMs) {
      data = { count: 1, windowStart: now, windowMs };
      rateLimitStore.set(key, data);
      return next();
    }
    
    data.count++;
    
    if (data.count > maxRequests) {
      const resetIn = Math.ceil((windowMs - (now - data.windowStart)) / 1000);
      res.setHeader('Retry-After', resetIn);
      return res.status(429).json({ 
        error: 'Too many requests. Please slow down.',
        retryAfter: resetIn
      });
    }
    
    next();
  };
};

module.exports = {
  checkRateLimit,
  recordLoginAttempt,
  getClientIP,
  createRateLimiter,
  createAccountRateLimiter
};
