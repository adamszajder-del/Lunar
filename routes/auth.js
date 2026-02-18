// Auth Routes - /api/auth/*
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const db = require('../database');
const config = require('../config');
const { authMiddleware, invalidateUserCache } = require('../middleware/auth');
const { checkRateLimit, recordLoginAttempt, getClientIP } = require('../middleware/rateLimit');
const { sanitizeEmail, sanitizeString, validatePassword, validateUsername } = require('../utils/validators');
const { sendEmail, templates } = require('../utils/email');
const { generatePublicId } = require('../utils/publicId');

// Register - with approval system and password validation
router.post('/register', async (req, res) => {
  try {
    const email = sanitizeEmail(req.body.email);
    const password = req.body.password;
    const username = sanitizeString(req.body.username, 50);
    const birthdate = req.body.birthdate;
    const gdpr_consent = req.body.gdpr_consent;
    
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password and username are required' });
    }

    // Validate username format
    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) {
      return res.status(400).json({ 
        error: usernameCheck.errors[0],
        errors: usernameCheck.errors,
        field: 'username',
        code: 'INVALID_USERNAME'
      });
    }

    // Validate password strength
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ 
        error: passwordCheck.errors[0],
        errors: passwordCheck.errors,
        field: 'password',
        code: 'WEAK_PASSWORD'
      });
    }

    // Check if email exists
    const existingEmail = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Email already registered',
        field: 'email',
        code: 'EMAIL_EXISTS'
      });
    }

    // Check if username exists
    const existingUsername = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUsername.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Username already taken',
        field: 'username',
        code: 'USERNAME_EXISTS'
      });
    }

    // Hash password with higher cost factor
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate public_id
    const publicId = await generatePublicId('users', 'USER');

    // Try insert with all columns including birthdate
    let result;
    try {
      result = await db.query(
        `INSERT INTO users (public_id, email, password_hash, username, birthdate, gdpr_consent, is_approved, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, false, NOW()) 
         RETURNING id, public_id, email, username, birthdate`,
        [publicId, email, passwordHash, username, birthdate || null, gdpr_consent || false]
      );
    } catch (insertErr) {
      // Fallback without birthdate if column doesn't exist
      try {
        result = await db.query(
          `INSERT INTO users (public_id, email, password_hash, username, gdpr_consent, is_approved, created_at) 
           VALUES ($1, $2, $3, $4, $5, false, NOW()) 
           RETURNING id, public_id, email, username`,
          [publicId, email, passwordHash, username, gdpr_consent || false]
        );
      } catch (insertErr2) {
        // Fallback to basic columns only
        result = await db.query(
          `INSERT INTO users (public_id, email, password_hash, username) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id, public_id, email, username`,
          [publicId, email, passwordHash, username]
        );
      }
    }

    const user = result.rows[0];

    // Send registration pending email
    sendEmail(email, templates.registrationPending(username));

    // Don't generate token - user needs approval first
    res.status(201).json({ 
      message: 'Registration successful! Your account is pending admin approval.',
      pending_approval: true,
      user: { id: user.id, email: user.email, username: user.username }
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login - with rate limiting and approval check
router.post('/login', async (req, res) => {
  try {
    const email = sanitizeEmail(req.body.email);
    const password = req.body.password;
    
    // Get IP and User Agent for logging
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Check rate limit
    const rateLimit = checkRateLimit(ipAddress);
    if (!rateLimit.allowed) {
      return res.status(429).json({ 
        error: `Too many login attempts. Please try again in ${rateLimit.resetIn} minutes.`,
        code: 'RATE_LIMITED',
        resetIn: rateLimit.resetIn
      });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Fix SEC-CRIT-3: explicit columns — no reset_token, no unnecessary fields in memory
    const result = await db.query(
      `SELECT id, public_id, email, username, display_name, avatar_base64,
              password_hash, is_admin, is_blocked, is_approved,
              COALESCE(is_coach, false) as is_coach,
              COALESCE(is_staff, false) as is_staff,
              COALESCE(is_club_member, false) as is_club_member
       FROM users WHERE email = $1`,
      [email]
    );
    if (result.rows.length === 0) {
      recordLoginAttempt(ipAddress, false);
      // Log failed login attempt (user not found)
      try {
        await db.query(
          'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES (NULL, $1, $2, $3, false)',
          [email, ipAddress, userAgent]
        );
      } catch (logErr) { /* ignore if table doesn't exist */ }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    
    // Check if user is blocked
    if (user.is_blocked) {
      recordLoginAttempt(ipAddress, false);
      try {
        await db.query(
          'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, false)',
          [user.id, email, ipAddress, userAgent]
        );
      } catch (logErr) { /* ignore */ }
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      recordLoginAttempt(ipAddress, false);
      try {
        await db.query(
          'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, false)',
          [user.id, email, ipAddress, userAgent]
        );
      } catch (logErr) { /* ignore */ }
      
      const newLimit = checkRateLimit(ipAddress);
      return res.status(401).json({ 
        error: 'Invalid credentials',
        remainingAttempts: newLimit.remaining
      });
    }

    // Check if user is approved
    if (user.is_approved === false && !user.is_admin) {
      return res.status(403).json({ 
        error: 'Your account is pending admin approval. Please wait for confirmation.',
        pending_approval: true
      });
    }

    // Clear rate limit on successful login
    recordLoginAttempt(ipAddress, true);

    // Log successful login and update last_login
    try {
      await db.query(
        'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, true)',
        [user.id, email, ipAddress, userAgent]
      );
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    } catch (logErr) { /* ignore */ }

    // Generate JWT
    const token = jwt.sign(
      { 
        userId: user.id,
        iat: Math.floor(Date.now() / 1000)
      }, 
      config.JWT_SECRET, 
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    res.json({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        username: user.username,
        display_name: user.display_name || null,
        is_admin: user.is_admin || false,
        is_coach: user.is_coach || false,
        is_staff: user.is_staff || false,
        is_club_member: user.is_club_member || false,
        avatar_base64: user.avatar_base64 || null
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout endpoint
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const email = sanitizeEmail(req.body.email);
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user
    const result = await db.query('SELECT id, email, username FROM users WHERE email = $1', [email]);
    
    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ message: 'If an account exists with this email, you will receive a password reset link.' });
    }

    const user = result.rows[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store hashed token in database
    try {
      await db.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [resetTokenHash, resetExpires, user.id]
      );
    } catch (dbErr) {
      // If columns don't exist, create them
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255)');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP');
      await db.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [resetTokenHash, resetExpires, user.id]
      );
    }

    // Send password reset email
    await sendEmail(user.email, templates.passwordReset(user.username, resetToken));

    res.json({ message: 'If an account exists with this email, you will receive a password reset link.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify reset token
router.get('/verify-reset-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await db.query(
      'SELECT id, username FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token', code: 'INVALID_TOKEN' });
    }

    res.json({ valid: true, username: result.rows[0].username });
  } catch (error) {
    console.error('Verify reset token error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password with token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    // Validate password strength
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ 
        error: passwordCheck.errors[0],
        errors: passwordCheck.errors,
        code: 'WEAK_PASSWORD'
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with valid token
    const result = await db.query(
      'SELECT id, email, username FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token', code: 'INVALID_TOKEN' });
    }

    const user = result.rows[0];

    // Hash new password
    const passwordHash = await bcrypt.hash(password, 12);

    // Update password and clear reset token
    await db.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, password_changed_at = NOW() WHERE id = $2',
      [passwordHash, user.id]
    );

    // Invalidate user cache so blocked/password checks are immediate
    invalidateUserCache(user.id);

    // Send password changed confirmation email
    await sendEmail(user.email, templates.passwordChanged(user.username));

    res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================================
// GOOGLE OAUTH
// ============================================================================

// GET /api/auth/google/url — returns the Google consent screen URL
router.get('/google/url', (req, res) => {
  if (!config.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google Sign-In is not configured' });
  }

  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// POST /api/auth/google — exchange code for token, create/find user, return JWT
router.post('/google', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Google Sign-In is not configured' });
    }

    // 1. Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) {
      console.error('Google token exchange error:', tokens);
      return res.status(401).json({ error: 'Google authentication failed', detail: tokens.error_description || tokens.error });
    }

    // 2. Get user info from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    const googleUser = await userInfoRes.json();
    if (!googleUser.email) {
      return res.status(401).json({ error: 'Could not retrieve email from Google' });
    }

    const googleId = googleUser.id;
    const googleEmail = googleUser.email.toLowerCase();
    const googleName = googleUser.name || googleEmail.split('@')[0];
    const googleAvatar = googleUser.picture || null;

    // 3. Find or create user
    // First: check by google_id (returning user with Google)
    let userResult = await db.query(
      `SELECT id, public_id, email, username, display_name, avatar_base64,
              is_admin, is_blocked, is_approved,
              COALESCE(is_coach, false) as is_coach,
              COALESCE(is_staff, false) as is_staff,
              COALESCE(is_club_member, false) as is_club_member
       FROM users WHERE google_id = $1`,
      [googleId]
    );

    let user;

    if (userResult.rows.length > 0) {
      // Existing Google user — log them in
      user = userResult.rows[0];
    } else {
      // Check by email (maybe registered with email, now linking Google)
      userResult = await db.query(
        `SELECT id, public_id, email, username, display_name, avatar_base64,
                is_admin, is_blocked, is_approved, google_id,
                COALESCE(is_coach, false) as is_coach,
                COALESCE(is_staff, false) as is_staff,
                COALESCE(is_club_member, false) as is_club_member
         FROM users WHERE email = $1`,
        [googleEmail]
      );

      if (userResult.rows.length > 0) {
        // Email exists — link Google ID to existing account
        user = userResult.rows[0];
        await db.query('UPDATE users SET google_id = $1, auth_provider = $2 WHERE id = $3', 
          [googleId, user.google_id ? 'both' : 'both', user.id]);
      } else {
        // Brand new user — create account
        const publicId = await generatePublicId('users', 'USER');
        
        // Generate a username from Google name (sanitized)
        let baseUsername = googleName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
        let username = baseUsername;
        let suffix = 1;
        
        // Ensure username uniqueness
        while (true) {
          const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
          if (existing.rows.length === 0) break;
          username = `${baseUsername}${suffix}`;
          suffix++;
        }

        // Random password hash (user won't need it — they log in via Google)
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const passwordHash = await bcrypt.hash(randomPassword, 12);

        const insertResult = await db.query(
          `INSERT INTO users (public_id, email, password_hash, username, display_name, google_id, auth_provider, is_approved, gdpr_consent, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'google', false, true, NOW())
           RETURNING id, public_id, email, username, display_name, avatar_base64, is_admin,
                     COALESCE(is_coach, false) as is_coach,
                     COALESCE(is_staff, false) as is_staff,
                     COALESCE(is_club_member, false) as is_club_member`,
          [publicId, googleEmail, passwordHash, username, googleName, googleId]
        );

        user = insertResult.rows[0];

        // Send registration pending email
        sendEmail(googleEmail, templates.registrationPending(username));

        // New Google user needs approval (same as email registration)
        return res.status(201).json({
          message: 'Registration successful! Your account is pending admin approval.',
          pending_approval: true,
          user: { id: user.id, email: user.email, username: user.username }
        });
      }
    }

    // 4. Existing user checks
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }

    if (user.is_approved === false && !user.is_admin) {
      return res.status(403).json({
        error: 'Your account is pending admin approval. Please wait for confirmation.',
        pending_approval: true
      });
    }

    // 5. Log login
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    try {
      await db.query(
        'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, true)',
        [user.id, user.email, ipAddress, userAgent]
      );
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    } catch (logErr) { /* ignore */ }

    // 6. Generate JWT
    const token = jwt.sign(
      { userId: user.id, iat: Math.floor(Date.now() / 1000) },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    res.json({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        username: user.username,
        display_name: user.display_name || null,
        is_admin: user.is_admin || false,
        is_coach: user.is_coach || false,
        is_staff: user.is_staff || false,
        is_club_member: user.is_club_member || false,
        avatar_base64: user.avatar_base64 || null
      },
      token
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
