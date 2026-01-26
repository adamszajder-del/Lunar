// Configuration - Environment variables and constants
// Flatwater by Lunar

// JWT Secret - MUST be set in production
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('⚠️  WARNING: JWT_SECRET not set in environment variables!');
  console.error('⚠️  Using fallback key - NOT SAFE FOR PRODUCTION!');
}

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  
  // JWT
  JWT_SECRET: JWT_SECRET || 'dev-only-fallback-key-not-for-production',
  JWT_EXPIRES_IN: '24h',
  
  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || 'sk_test_51StcCnHb50tRNmW1SbY74lR9Iea02w4NwiujPgV35lQCMRXDPbuAlvx8OT4XBu1qBUrCDPcGhZfPpSW40bx2gRKi008vTcmpG9',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_51StcCnHb50tRNmW1Dcs4vJ8xvN2R13epSKObQcTPZ3Ar5oGMQr9upBr3s2MIiZxsOGbyMqUMmHsLXAXeHBZq3P3C00o8CWplx2',
  
  // Email (Postmark)
  POSTMARK_API_KEY: process.env.POSTMARK_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM || 'Flatwater by Lunar <noreply@flatwater.space>',
  APP_URL: process.env.APP_URL || 'https://flatwater.space',
  
  // Rate Limiting
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
  MAX_LOGIN_ATTEMPTS: 5,
  
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
