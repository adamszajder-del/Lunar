// Input Validation Utilities

// Escape HTML entities to prevent XSS
const escapeHtml = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// Sanitize string input (trim + truncate, NO html escape — use sanitizeHtml for user-facing text)
const sanitizeString = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
};

// Sanitize string + escape HTML (use for any user-generated text stored in DB)
const sanitizeHtml = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return escapeHtml(str.trim().slice(0, maxLength));
};

// Sanitize URL — allow only http/https, strip javascript: etc.
const sanitizeUrl = (url, maxLength = 2048) => {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim().slice(0, maxLength);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return '';
};

// Sanitize and validate email
const sanitizeEmail = (email) => {
  if (!email || typeof email !== 'string') return '';
  const cleaned = email.trim().toLowerCase().slice(0, 255);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : '';
};

// Sanitize number within range
const sanitizeNumber = (num, min = 0, max = 999999) => {
  const parsed = parseFloat(num);
  if (isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
};

// Validate password strength
const validatePassword = (password) => {
  const errors = [];
  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  return { valid: errors.length === 0, errors };
};

// Validate username
const validateUsername = (username) => {
  const errors = [];
  if (!username || username.length < 3) {
    errors.push('Username must be at least 3 characters long');
  }
  if (username && username.length > 50) {
    errors.push('Username must be at most 50 characters long');
  }
  // Allow letters (including Polish/unicode), numbers, underscores, hyphens, dots
  if (username && !/^[\p{L}\p{N}_.\-]+$/u.test(username)) {
    errors.push('Username can only contain letters, numbers, underscores, hyphens, and dots');
  }
  return { valid: errors.length === 0, errors };
};

// Sanitize date string (YYYY-MM-DD format)
const sanitizeDate = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return dateStr;
};

// Sanitize time string (HH:MM format)
const sanitizeTime = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;
  if (!timeRegex.test(timeStr)) return null;
  return timeStr;
};

module.exports = {
  escapeHtml,
  sanitizeString,
  sanitizeHtml,
  sanitizeUrl,
  sanitizeEmail,
  sanitizeNumber,
  validatePassword,
  validateUsername,
  sanitizeDate,
  sanitizeTime
};
