// CSRF Protection — Defense-in-depth for admin panel
// Generates per-session tokens, validates on mutating requests
// Note: With JWT in Authorization header (not cookies), classic CSRF is already
// mitigated. This adds an extra layer in case architecture changes.

const crypto = require('crypto');

/**
 * Generate a CSRF token (include in login response, store client-side)
 * @returns {string} 32-byte hex token
 */
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Middleware: validate CSRF token on mutating requests (POST/PUT/PATCH/DELETE)
 * Token must be in X-CSRF-Token header
 * Skips GET/HEAD/OPTIONS requests
 */
const csrfProtection = (req, res, next) => {
  // Skip safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const csrfToken = req.headers['x-csrf-token'];
  const sessionCsrf = req.user?.csrfToken;

  // If no CSRF token system is active for this user, skip (backward compat)
  if (!sessionCsrf) {
    return next();
  }

  if (!csrfToken || csrfToken !== sessionCsrf) {
    return res.status(403).json({ error: 'Invalid CSRF token', code: 'CSRF_FAILED' });
  }

  next();
};

module.exports = { generateToken, csrfProtection };
