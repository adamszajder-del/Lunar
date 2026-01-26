// Input Validation Utilities

// Sanitize string input
const sanitizeString = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
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
  if (username.length > 50) {
    errors.push('Username must be at most 50 characters long');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, and underscores');
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
  sanitizeString,
  sanitizeEmail,
  sanitizeNumber,
  validatePassword,
  validateUsername,
  sanitizeDate,
  sanitizeTime
};
