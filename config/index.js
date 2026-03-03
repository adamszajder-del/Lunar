// Configuration - Environment variables and constants
// Flatwater by Lunar

// Critical env checks - fail fast if missing in production
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

if (!process.env.JWT_SECRET) {
  if (isProduction) {
    console.error('FATAL: JWT_SECRET not set in production!');
    process.exit(1);
  }
  console.warn('⚠️  WARNING: JWT_SECRET not set - using dev fallback (NOT SAFE FOR PRODUCTION)');
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  WARNING: STRIPE_SECRET_KEY not set - payments will not work');
}

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'dev-only-fallback-key-change-in-production',
  JWT_EXPIRES_IN: '4h',
  
  // Stripe — NO HARDCODED KEYS
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  
  // Google OAuth
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || (process.env.APP_URL || 'https://flatwater.space') + '?auth=google',
  
  // Email (Postmark)
  POSTMARK_API_KEY: process.env.POSTMARK_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM || 'Flatwater by Lunar <noreply@flatwater.space>',
  APP_URL: process.env.APP_URL || 'https://flatwater.space',
  
  // Rate Limiting
  RATE_LIMIT_WINDOW: 15 * 60 * 1000,
  MAX_LOGIN_ATTEMPTS: 5,
  
  // Migrations
  MIGRATION_KEY: process.env.MIGRATION_KEY,
  
  // CORS
  ALLOWED_ORIGINS: [
    'https://wakeway.home.pl',
    'https://www.wakeway.home.pl',
    'https://wakeway.pl',
    'https://www.wakeway.pl',
    'https://flatwater.space',
    'https://www.flatwater.space',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
  ]
};
