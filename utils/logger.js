// Structured logger — replaces raw console.log/error with consistent format
// Outputs JSON in production, readable format in development
// Usage: const log = require('../utils/logger');
//        log.info('Server started', { port: 3000 });
//        log.error('Query failed', { query, error: err.message });

const isProd = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

function formatMessage(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  
  if (isProd) {
    return JSON.stringify(entry);
  }
  
  // Dev-friendly format
  const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍' }[level] || '  ';
  const dataStr = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `${prefix} [${entry.ts.slice(11, 19)}] ${msg}${dataStr}`;
}

const log = {
  info(msg, data = {}) {
    console.log(formatMessage('info', msg, data));
  },
  
  warn(msg, data = {}) {
    console.warn(formatMessage('warn', msg, data));
  },
  
  error(msg, data = {}) {
    // Extract error object info if passed
    if (data.error instanceof Error) {
      data = { ...data, error: data.error.message, stack: data.error.stack?.split('\n').slice(0, 3).join(' | ') };
    }
    if (data instanceof Error) {
      data = { error: data.message, stack: data.stack?.split('\n').slice(0, 3).join(' | ') };
    }
    console.error(formatMessage('error', msg, data));
  },
  
  debug(msg, data = {}) {
    if (!isProd) {
      console.log(formatMessage('debug', msg, data));
    }
  },
};

module.exports = log;
