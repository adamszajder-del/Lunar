// Flatwater by Lunar - Server API
// VERSION: v64-achievements-fix-2025-01-26
// Fixed: Admin achievements loading, grant multiple achievements, role management

const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe configuration
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_51StcCnHb50tRNmW1SbY74lR9Iea02w4NwiujPgV35lQCMRXDPbuAlvx8OT4XBu1qBUrCDPcGhZfPpSW40bx2gRKi008vTcmpG9';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_51StcCnHb50tRNmW1Dcs4vJ8xvN2R13epSKObQcTPZ3Ar5oGMQr9upBr3s2MIiZxsOGbyMqUMmHsLXAXeHBZq3P3C00o8CWplx2';
const stripe = require('stripe')(STRIPE_SECRET_KEY);

// JWT Secret - MUST be set in production
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('⚠️  WARNING: JWT_SECRET not set in environment variables!');
  console.error('⚠️  Using fallback key - NOT SAFE FOR PRODUCTION!');
}
const jwtSecret = JWT_SECRET || 'dev-only-fallback-key-not-for-production';

// Allowed origins for CORS
const allowedOrigins = [
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
];

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(null, true); // W trybie dev pozwalamy, logujemy tylko
      // W produkcji zmień na: callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Input validation helpers
const sanitizeString = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
};

const sanitizeEmail = (email) => {
  if (!email || typeof email !== 'string') return '';
  const cleaned = email.trim().toLowerCase().slice(0, 255);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : '';
};

const sanitizeNumber = (num, min = 0, max = 999999) => {
  const parsed = parseFloat(num);
  if (isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
};

// ==================== AUTH ROUTES ====================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Register - with approval system
app.post('/api/auth/register', async (req, res) => {
  try {
    const email = sanitizeEmail(req.body.email);
    const password = req.body.password;
    const username = sanitizeString(req.body.username, 50);
    const birthdate = req.body.birthdate;
    const gdpr_consent = req.body.gdpr_consent;
    
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password and username are required' });
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

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

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

    // Don't generate token - user needs approval first
    res.status(201).json({ 
      message: 'Registration successful! Your account is pending admin approval.',
      pending_approval: true,
      user: { id: user.id, email: user.email, username: user.username }
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Login - with approval check
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = sanitizeEmail(req.body.email);
    const password = req.body.password;
    
    // Get IP and User Agent for logging
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
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
      // Log failed login attempt (blocked user)
      try {
        await db.query(
          'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, false)',
          [user.id, email, ipAddress, userAgent]
        );
      } catch (logErr) { /* ignore if table doesn't exist */ }
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      // Log failed login attempt (wrong password)
      try {
        await db.query(
          'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, false)',
          [user.id, email, ipAddress, userAgent]
        );
      } catch (logErr) { /* ignore if table doesn't exist */ }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is approved (skip check if column doesn't exist or is null - for backwards compatibility)
    if (user.is_approved === false && !user.is_admin) {
      return res.status(403).json({ 
        error: 'Your account is pending admin approval. Please wait for confirmation.',
        pending_approval: true
      });
    }

    // Log successful login and update last_login
    try {
      await db.query(
        'INSERT INTO user_logins (user_id, email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4, true)',
        [user.id, email, ipAddress, userAgent]
      );
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    } catch (logErr) { /* ignore if table doesn't exist */ }

    const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });

    res.json({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        username: user.username,
        display_name: user.display_name || null,
        is_admin: user.is_admin || false,
        is_coach: user.is_coach || false,
        avatar_base64: user.avatar_base64 || null
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware - checks Authorization header only
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, jwtSecret);
    const result = await db.query(`
      SELECT id, public_id, email, username, is_admin, 
             COALESCE(is_coach, false) as is_coach,
             COALESCE(is_staff, false) as is_staff,
             COALESCE(is_club_member, false) as is_club_member
      FROM users WHERE id = $1
    `, [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Logout endpoint (client handles token removal)
app.post('/api/auth/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ==================== USER PROFILE ROUTES ====================

// Update user profile (email/password)
app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const email = req.body.email ? sanitizeEmail(req.body.email) : null;
    const password = req.body.password;
    const userId = req.user.id;

    // Validate password if provided
    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (email) {
      // Check if email is already taken by another user
      const existing = await db.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    let query, params;
    
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      if (email) {
        query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, email, username';
        params = [email, passwordHash, userId];
      } else {
        query = 'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email, username';
        params = [passwordHash, userId];
      }
    } else if (email) {
      query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, username';
      params = [email, userId];
    } else {
      return res.status(400).json({ error: 'No changes provided' });
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar
app.put('/api/users/me/avatar', authMiddleware, async (req, res) => {
  try {
    const { avatar_base64 } = req.body;
    const userId = req.user.id;

    await db.query(
      'UPDATE users SET avatar_base64 = $1 WHERE id = $2',
      [avatar_base64, userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update avatar error:', error);
    if (error.message.includes('column') && error.message.includes('does not exist')) {
      res.status(500).json({ error: 'Please run migration first: /api/run-migration?key=lunar2025' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// ==================== TRICKS ROUTES ====================

// Get all tricks
app.get('/api/tricks', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tricks ORDER BY category, difficulty');
    res.json(result.rows);
  } catch (error) {
    console.error('Get tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's trick progress
app.get('/api/tricks/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT trick_id, status, notes FROM user_tricks WHERE user_id = $1',
      [req.user.id]
    );
    
    // Convert to object format { trickId: { status, notes } }
    const progress = {};
    result.rows.forEach(row => {
      progress[row.trick_id] = { status: row.status, notes: row.notes };
    });
    
    res.json(progress);
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick progress
app.post('/api/tricks/progress', authMiddleware, async (req, res) => {
  try {
    const { trickId, status, notes } = req.body;

    await db.query(`
      INSERT INTO user_tricks (user_id, trick_id, status, notes)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, trick_id)
      DO UPDATE SET status = $3, notes = $4, updated_at = NOW()
    `, [req.user.id, trickId, status, notes || '']);

    res.json({ success: true });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN TRICKS ROUTES ====================

// Create trick (admin)
app.post('/api/admin/tricks', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, category, difficulty, description, full_description, video_url } = req.body;
    const publicId = await generatePublicId('tricks', 'TRICK');

    const result = await db.query(
      `INSERT INTO tricks (public_id, name, category, difficulty, description, full_description, video_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, name, category, difficulty, description || '', full_description || '', video_url || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick (admin)
app.put('/api/admin/tricks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, category, difficulty, description, full_description, video_url } = req.body;

    const result = await db.query(
      `UPDATE tricks SET name = $1, category = $2, difficulty = $3, description = $4, full_description = $5, video_url = $6
       WHERE id = $7 RETURNING *`,
      [name, category, difficulty, description, full_description, video_url, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete trick (admin)
app.delete('/api/admin/tricks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM tricks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== EVENTS ROUTES ====================

// Get all events
app.get('/api/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, 
             u.username as creator_username,
             u.id as creator_id,
             u.avatar_base64 as creator_avatar,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e
      LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date, e.time
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's registered events
app.get('/api/events/registered', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT event_id FROM event_attendees WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows.map(r => r.event_id));
  } catch (error) {
    console.error('Get registered events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register for event
app.post('/api/events/:id/register', authMiddleware, async (req, res) => {
  try {
    const eventId = req.params.id;

    // Check if already registered
    const existing = await db.query(
      'SELECT id FROM event_attendees WHERE event_id = $1 AND user_id = $2',
      [eventId, req.user.id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already registered' });
    }

    // Check spots
    const event = await db.query('SELECT spots FROM events WHERE id = $1', [eventId]);
    const attendees = await db.query('SELECT COUNT(*) as count FROM event_attendees WHERE event_id = $1', [eventId]);

    if (attendees.rows[0].count >= event.rows[0].spots) {
      return res.status(400).json({ error: 'Event is full' });
    }

    await db.query(
      'INSERT INTO event_attendees (event_id, user_id) VALUES ($1, $2)',
      [eventId, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Register event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unregister from event
app.delete('/api/events/:id/register', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM event_attendees WHERE event_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Unregister event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get event participants
app.get('/api/events/:id/participants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_base64
      FROM event_attendees ea
      JOIN users u ON ea.user_id = u.id
      WHERE ea.event_id = $1
      ORDER BY ea.created_at
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get event participants error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN EVENTS ROUTES ====================

// Get all events (admin)
app.get('/api/admin/events', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(`
      SELECT e.*, 
             u.username as author_username,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e
      LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get admin events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create event (admin)
app.post('/api/admin/events', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, date, time, location, location_url, spots } = req.body;
    const publicId = await generatePublicId('events', 'EVENT');

    const result = await db.query(
      `INSERT INTO events (public_id, name, date, time, location, location_url, spots, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, date, time, location, location_url || null, spots || 10, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update event (admin)
app.put('/api/admin/events/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, date, time, location, location_url, spots } = req.body;

    const result = await db.query(
      `UPDATE events SET name = $1, date = $2, time = $3, location = $4, location_url = $5, spots = $6
       WHERE id = $7 RETURNING *`,
      [name, date, time, location, location_url, spots, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete event (admin)
app.delete('/api/admin/events/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USERS/CREW ROUTES ====================

// Get all crew members (public profiles)
app.get('/api/users/crew', async (req, res) => {
  try {
    // First try with all columns including article stats
    let result;
    try {
      result = await db.query(`
        SELECT id, public_id, username, display_name, avatar_base64, 
               COALESCE(is_coach, false) as is_coach, 
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               role,
               COALESCE((SELECT COUNT(*) FROM user_tricks WHERE user_id = users.id AND status = 'mastered'), 0) as mastered,
               COALESCE((SELECT COUNT(*) FROM user_tricks WHERE user_id = users.id AND status = 'in_progress'), 0) as in_progress,
               COALESCE((SELECT COUNT(*) FROM user_article_status WHERE user_id = users.id AND status = 'known'), 0) as articles_read,
               COALESCE((SELECT COUNT(*) FROM user_article_status WHERE user_id = users.id AND status = 'to_read'), 0) as articles_to_read
        FROM users
        WHERE (is_approved = true OR is_approved IS NULL) AND is_admin = false
        ORDER BY is_coach DESC NULLS LAST, username
      `);
    } catch (err) {
      // Fallback to basic columns if some don't exist - also filter by approved
      result = await db.query(`
        SELECT id, public_id, username, display_name
        FROM users
        WHERE (is_approved = true OR is_approved IS NULL) AND (is_admin = false OR is_admin IS NULL)
        ORDER BY username
      `);
      // Add default values
      result.rows = result.rows.map(u => ({
        ...u,
        is_coach: false,
        is_staff: false,
        is_club_member: false,
        role: null,
        mastered: 0,
        in_progress: 0,
        articles_read: 0,
        articles_to_read: 0,
        avatar_base64: null
      }));
    }
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get crew error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// ==================== FAVORITES ROUTES ====================

// Get user's favorites
app.get('/api/users/favorites', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT item_type, item_id FROM favorites WHERE user_id = $1',
      [req.user.id]
    );
    
    const favorites = result.rows;
    
    const response = {
      tricks: favorites.filter(f => f.item_type === 'trick').map(f => f.item_id),
      articles: favorites.filter(f => f.item_type === 'article').map(f => f.item_id),
      users: favorites.filter(f => f.item_type === 'user').map(f => f.item_id)
    };
    
    res.json(response);
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Toggle favorite
app.post('/api/users/favorites', authMiddleware, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    
    if (!['trick', 'article', 'user'].includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    
    // Check if already exists
    const existing = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
      [req.user.id, item_type, item_id]
    );
    
    if (existing.rows.length > 0) {
      // Remove favorite
      await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
      res.json({ isFavorite: false });
    } else {
      // Add favorite
      await db.query(
        'INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)',
        [req.user.id, item_type, item_id]
      );
      res.json({ isFavorite: true });
    }
  } catch (err) {
    console.error('Toggle favorite error:', err);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// ==================== ADMIN USERS ROUTES ====================

// Get all users (admin) - with auth check
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Try with new columns first, fallback to basic query
    let result;
    try {
      result = await db.query(`
        SELECT id, public_id, email, username, display_name, birthdate, is_admin, is_approved, 
               COALESCE(is_blocked, false) as is_blocked, 
               COALESCE(is_coach, false) as is_coach,
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               last_login, created_at 
        FROM users 
        WHERE is_approved = true OR is_approved IS NULL OR is_admin = true
        ORDER BY created_at DESC
      `);
    } catch (queryErr) {
      // Fallback if columns don't exist
      console.log('Falling back to basic users query:', queryErr.message);
      result = await db.query(`
        SELECT id, public_id, email, username, display_name, birthdate, is_admin, is_approved, 
               false as is_blocked, false as is_coach, false as is_staff, false as is_club_member,
               NULL as last_login, created_at 
        FROM users 
        WHERE is_approved = true OR is_approved IS NULL OR is_admin = true
        ORDER BY created_at DESC
      `);
    }
    res.json(result.rows);
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pending users (waiting for approval)
app.get('/api/admin/pending-users', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(
      `SELECT id, email, username, display_name, created_at 
       FROM users 
       WHERE is_approved = false AND is_admin = false
       ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get pending users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve user
app.post('/api/admin/approve-user/:userId', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;

    const result = await db.query(
      `UPDATE users 
       SET is_approved = true, approved_at = NOW(), approved_by = $1 
       WHERE id = $2 
       RETURNING id, email, username, is_approved`,
      [req.user.id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ 
      message: 'User approved successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject user (delete account)
app.delete('/api/admin/reject-user/:userId', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;

    // Make sure we're not deleting an approved user or admin
    const userCheck = await db.query(
      'SELECT is_approved, is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userCheck.rows[0].is_approved || userCheck.rows[0].is_admin) {
      return res.status(400).json({ error: 'Cannot reject an approved user or admin' });
    }

    await db.query('DELETE FROM users WHERE id = $1', [userId]);

    res.json({ message: 'User rejected and removed' });
  } catch (error) {
    console.error('Reject user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (admin)
app.post('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, username, display_name, is_admin } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const publicId = await generatePublicId('users', 'USER');

    const result = await db.query(
      `INSERT INTO users (public_id, email, password_hash, username, display_name, is_admin, is_approved) 
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id, public_id, email, username, display_name, is_admin, created_at`,
      [publicId, email, passwordHash, username, display_name || null, is_admin || false]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin)
app.put('/api/admin/users/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, username, display_name, is_admin } = req.body;
    
    let query, params;
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      query = `UPDATE users SET email = $1, password_hash = $2, username = $3, display_name = $4, is_admin = $5
               WHERE id = $6 RETURNING id, public_id, email, username, display_name, is_admin, created_at`;
      params = [email, passwordHash, username, display_name, is_admin, req.params.id];
    } else {
      query = `UPDATE users SET email = $1, username = $2, display_name = $3, is_admin = $4
               WHERE id = $5 RETURNING id, public_id, email, username, display_name, is_admin, created_at`;
      params = [email, username, display_name, is_admin, req.params.id];
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin)
app.delete('/api/admin/users/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NEWS ROUTES ====================

// Get all news
app.get('/api/news', async (req, res) => {
  try {
    // Check if user is authenticated (optional)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (err) {
        // Token invalid, just return global news
      }
    }
    
    // Check if user_id column exists
    let hasUserIdColumn = true;
    try {
      await db.query('SELECT user_id FROM news LIMIT 1');
    } catch (err) {
      hasUserIdColumn = false;
    }
    
    // Return news based on column availability
    let query, params;
    if (hasUserIdColumn && userId) {
      query = 'SELECT * FROM news WHERE user_id IS NULL OR user_id = $1 ORDER BY created_at DESC';
      params = [userId];
    } else if (hasUserIdColumn) {
      query = 'SELECT * FROM news WHERE user_id IS NULL ORDER BY created_at DESC';
      params = [];
    } else {
      // Fallback if user_id column doesn't exist yet
      query = 'SELECT * FROM news ORDER BY created_at DESC';
      params = [];
    }
    
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN NEWS ROUTES ====================

// Get all global news (for admin panel - excludes personal/purchase thank you messages)
app.get('/api/admin/news', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    // Only return global news (user_id IS NULL), not personal thank you messages
    const result = await db.query('SELECT * FROM news WHERE user_id IS NULL ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Get admin news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create news (admin)
app.post('/api/admin/news', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { title, message, type, emoji, event_details } = req.body;
    const publicId = await generatePublicId('news', 'NEWS');

    const result = await db.query(
      `INSERT INTO news (public_id, title, message, type, emoji, event_details) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [publicId, title, message || '', type || 'info', emoji || null, event_details ? JSON.stringify(event_details) : null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update news (admin)
app.put('/api/admin/news/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { title, message, type, emoji, event_details } = req.body;

    const result = await db.query(
      `UPDATE news SET title = $1, message = $2, type = $3, emoji = $4, event_details = $5
       WHERE id = $6 RETURNING *`,
      [title, message, type, emoji, event_details ? JSON.stringify(event_details) : null, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete news (admin)
app.delete('/api/admin/news/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ARTICLES ROUTES ====================

// Get all articles (PUBLIC - no auth required)
app.get('/api/articles', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, category, title, description, content, read_time, created_at
      FROM articles
      ORDER BY category, title
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get articles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get articles by category (PUBLIC)
app.get('/api/articles/category/:category', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, category, title, description, content, read_time, created_at
      FROM articles
      WHERE category = $1
      ORDER BY title
    `, [req.params.category]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get articles by category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single article (PUBLIC)
app.get('/api/articles/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, category, title, description, content, read_time, created_at
      FROM articles
      WHERE id = $1 OR public_id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's article progress (requires auth)
app.get('/api/articles/user/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT article_id, status FROM user_articles WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get article progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user's article status (requires auth)
app.put('/api/articles/user/:articleId', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body; // 'fresh', 'to_read', 'known'
    
    await db.query(`
      INSERT INTO user_articles (user_id, article_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET status = $3, updated_at = NOW()
    `, [req.user.id, req.params.articleId, status]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Update article status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN ARTICLES ROUTES ====================

// Create article (admin)
app.post('/api/admin/articles', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { category, title, description, content, read_time } = req.body;
    const publicId = await generatePublicId('articles', 'ARTICLE');

    const result = await db.query(
      `INSERT INTO articles (public_id, category, title, description, content, read_time, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, category, title, description || '', content || '', read_time || '5 min', req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update article (admin)
app.put('/api/admin/articles/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { category, title, description, content, read_time } = req.body;

    const result = await db.query(
      `UPDATE articles SET category = $1, title = $2, description = $3, content = $4, read_time = $5
       WHERE id = $6 RETURNING *`,
      [category, title, description, content, read_time, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete article (admin)
app.delete('/api/admin/articles/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== PRODUCTS ROUTES ====================

// Get all products (public)
app.get('/api/products', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, name, category, price, description, duration, icon, gradient, is_active
      FROM products
      WHERE is_active = true
      ORDER BY category, name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all products including inactive
app.get('/api/admin/products', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(`
      SELECT id, public_id, name, category, price, description, duration, icon, gradient, is_active, created_at
      FROM products
      ORDER BY category, name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get all products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Create product
app.post('/api/admin/products', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const name = sanitizeString(req.body.name, 255);
    const category = sanitizeString(req.body.category, 100);
    const price = sanitizeNumber(req.body.price, 0, 99999);
    const description = sanitizeString(req.body.description, 2000);
    const duration = sanitizeString(req.body.duration, 50);
    const icon = sanitizeString(req.body.icon, 50);
    const gradient = sanitizeString(req.body.gradient, 255);
    
    if (!name || !category || price === 0) {
      return res.status(400).json({ error: 'Name, category, and price are required' });
    }

    const publicId = await generatePublicId('products', 'PRODUCT');

    const result = await db.query(`
      INSERT INTO products (public_id, name, category, price, description, duration, icon, gradient, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
      RETURNING *
    `, [publicId, name, category, price, description || null, duration || null, icon || null, gradient || null]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Update product
app.put('/api/admin/products/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const name = sanitizeString(req.body.name, 255);
    const category = sanitizeString(req.body.category, 100);
    const price = sanitizeNumber(req.body.price, 0, 99999);
    const description = sanitizeString(req.body.description, 2000);
    const duration = sanitizeString(req.body.duration, 50);
    const icon = sanitizeString(req.body.icon, 50);
    const gradient = sanitizeString(req.body.gradient, 255);
    const is_active = req.body.is_active;

    const result = await db.query(`
      UPDATE products 
      SET name = COALESCE($1, name),
          category = COALESCE($2, category),
          price = COALESCE($3, price),
          description = COALESCE($4, description),
          duration = $5,
          icon = $6,
          gradient = $7,
          is_active = COALESCE($8, is_active)
      WHERE id = $9
      RETURNING *
    `, [name, category, price, description, duration, icon, gradient, is_active, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete product
app.delete('/api/admin/products/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== CART ROUTES ====================

// Get user's cart
app.get('/api/cart', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.id, c.quantity, c.created_at,
             p.id as product_id, p.public_id as product_public_id, p.name, p.category, p.price, p.description, p.icon, p.gradient
      FROM cart_items c
      JOIN products p ON c.product_id = p.id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add item to cart
app.post('/api/cart', authMiddleware, async (req, res) => {
  try {
    const { product_id, quantity = 1 } = req.body;
    
    if (!product_id) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    // Check if item already in cart
    const existing = await db.query(
      'SELECT id, quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [req.user.id, product_id]
    );

    if (existing.rows.length > 0) {
      // Update quantity
      const newQty = existing.rows[0].quantity + quantity;
      await db.query(
        'UPDATE cart_items SET quantity = $1 WHERE id = $2',
        [newQty, existing.rows[0].id]
      );
    } else {
      // Insert new item
      await db.query(
        'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)',
        [req.user.id, product_id, quantity]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update cart item quantity
app.put('/api/cart/:productId', authMiddleware, async (req, res) => {
  try {
    const { quantity } = req.body;
    
    if (quantity <= 0) {
      // Remove item if quantity is 0 or negative
      await db.query(
        'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [req.user.id, req.params.productId]
      );
    } else {
      await db.query(
        'UPDATE cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
        [quantity, req.user.id, req.params.productId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update cart error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove item from cart
app.delete('/api/cart/:productId', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Remove from cart error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear cart
app.delete('/api/cart', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ORDERS & STRIPE ROUTES ====================

// Get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Create Stripe Checkout Session
app.post('/api/stripe/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { product_id, booking_date, booking_time, phone, shipping_address } = req.body;
    
    // Get product
    const productResult = await db.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = productResult.rows[0];
    const isClothes = product.category === 'clothes';
    
    // For non-clothes, booking_date is required
    if (!isClothes && !booking_date) {
      return res.status(400).json({ error: 'Booking date is required for this product' });
    }
    
    // For clothes, shipping_address is required
    if (isClothes && !shipping_address) {
      return res.status(400).json({ error: 'Shipping address is required for clothes' });
    }

    // Create order in pending state
    const publicId = await generatePublicId('orders', 'ORD');
    
    const orderResult = await db.query(`
      INSERT INTO orders (
        public_id, user_id, product_id, product_name, product_category, 
        amount, booking_date, booking_time, phone, shipping_address, 
        status, fake, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, NOW())
      RETURNING *
    `, [
      publicId, 
      req.user.id, 
      product.id, 
      product.name, 
      product.category,
      product.price,
      isClothes ? null : booking_date,
      isClothes ? null : (booking_time || null),
      phone || null,
      isClothes ? shipping_address : null,
      'pending_payment'
    ]);
    
    const order = orderResult.rows[0];

    // Create Stripe Checkout Session (Redirect mode)
    const baseUrl = req.headers.origin || 'https://wakeway.pl';
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: product.name,
            description: isClothes 
              ? `Shipping to: ${shipping_address}` 
              : `Booking: ${booking_date} at ${booking_time || 'Any time'}`,
          },
          unit_amount: Math.round(product.price * 100), // Stripe uses cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/?payment=success&order=${publicId}`,
      cancel_url: `${baseUrl}/?payment=cancelled&order=${publicId}`,
      customer_email: req.user.email,
      metadata: {
        order_id: order.id,
        order_public_id: publicId,
        user_id: req.user.id,
      },
    });

    // Update order with Stripe session ID
    await db.query(
      'UPDATE orders SET stripe_session_id = $1 WHERE id = $2',
      [session.id, order.id]
    );

    res.json({ 
      sessionId: session.id, 
      sessionUrl: session.url,
      orderId: publicId 
    });
  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Verify payment and complete order (called after redirect)
app.post('/api/orders/verify-payment', authMiddleware, async (req, res) => {
  try {
    const { order_id } = req.body;
    
    // Get order
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE public_id = $1 AND user_id = $2',
      [order_id, req.user.id]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    // Check Stripe session status
    if (order.stripe_session_id) {
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      
      if (session.payment_status === 'paid') {
        // Determine new status based on product type
        const newStatus = order.product_category === 'clothes' ? 'pending_shipment' : 'completed';
        
        await db.query(
          'UPDATE orders SET status = $1, stripe_payment_intent = $2 WHERE id = $3',
          [newStatus, session.payment_intent, order.id]
        );
        
        // Update phone in user profile if provided
        if (order.phone) {
          await db.query('UPDATE users SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = \'\')', 
            [order.phone, req.user.id]);
        }
        
        // Create personal thank you news for this user
        try {
          const newsPublicId = await generatePublicId('news', 'NEWS');
          const bookingInfo = order.booking_date 
            ? ` See you on ${new Date(order.booking_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${order.booking_time ? ` at ${order.booking_time}` : ''}!`
            : '';
          
          // Try to insert with user_id (if column exists)
          try {
            await db.query(
              `INSERT INTO news (public_id, title, message, type, emoji, user_id) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                newsPublicId,
                `Thank you for your purchase! 🎉`,
                `Thanks for purchasing ${order.product_name}!${bookingInfo} We hope you have an amazing time at Lunar Cable Park! Get ready for some awesome wakeboarding action! 🏄‍♂️💦`,
                'purchase',
                '🙏',
                req.user.id
              ]
            );
          } catch (insertErr) {
            // If user_id column doesn't exist, insert without it
            console.log('Inserting news without user_id:', insertErr.message);
            await db.query(
              `INSERT INTO news (public_id, title, message, type, emoji) 
               VALUES ($1, $2, $3, $4, $5)`,
              [
                newsPublicId,
                `Thank you for your purchase! 🎉`,
                `Thanks for purchasing ${order.product_name}!${bookingInfo} We hope you have an amazing time at Lunar Cable Park! Get ready for some awesome wakeboarding action! 🏄‍♂️💦`,
                'purchase',
                '🙏'
              ]
            );
          }
        } catch (newsErr) {
          console.error('Error creating thank you news:', newsErr);
          // Don't fail the whole request if news creation fails
        }
        
        return res.json({ 
          success: true, 
          status: newStatus,
          message: order.product_category === 'clothes' 
            ? 'Payment successful! Our team will contact you to arrange shipping.' 
            : 'Payment successful! Your booking has been confirmed.',
          order: {
            public_id: order.public_id,
            product_name: order.product_name,
            product_category: order.product_category,
            amount: order.amount,
            booking_date: order.booking_date,
            booking_time: order.booking_time
          }
        });
      }
    }
    
    res.json({ success: false, status: order.status, message: 'Payment not completed' });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's orders (for calendar and history)
app.get('/api/orders/my', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_id, product_name, product_category, 
             amount, booking_date, booking_time, status, created_at
      FROM orders 
      WHERE user_id = $1 AND status NOT IN ('pending_payment', 'cancelled')
      ORDER BY created_at DESC
    `, [req.user.id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get my orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's booked dates (for calendar display)
app.get('/api/orders/my-bookings', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_name, product_category, booking_date, booking_time, status
      FROM orders 
      WHERE user_id = $1 
        AND booking_date IS NOT NULL 
        AND status IN ('completed', 'pending_shipment')
      ORDER BY booking_date ASC
    `, [req.user.id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get my bookings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all orders
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(`
      SELECT o.*, u.username, u.email, u.public_id as user_public_id
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get all orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Update order status (for marking clothes as shipped)
app.patch('/api/admin/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { status } = req.body;
    const validStatuses = ['pending_payment', 'pending_shipment', 'completed', 'cancelled', 'shipped'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await db.query(`
      UPDATE orders SET status = $1 WHERE id = $2 RETURNING *
    `, [status, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get order stats
app.get('/api/admin/orders/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE fake = false) as total_real_orders,
        COUNT(*) FILTER (WHERE fake = true) as total_fake_orders,
        COALESCE(SUM(amount) FILTER (WHERE fake = false AND status IN ('completed', 'pending_shipment', 'shipped')), 0) as total_real_revenue,
        COUNT(*) FILTER (WHERE status = 'pending_shipment' AND fake = false) as pending_shipments,
        COUNT(*) FILTER (WHERE status = 'completed' AND fake = false) as completed_orders
      FROM orders
    `);
    
    const categoryStats = await db.query(`
      SELECT 
        product_category,
        COUNT(*) as order_count,
        COALESCE(SUM(amount), 0) as revenue
      FROM orders
      WHERE fake = false AND status IN ('completed', 'pending_shipment', 'shipped')
      GROUP BY product_category
    `);

    res.json({
      ...stats.rows[0],
      by_category: categoryStats.rows
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== LEGACY PURCHASES ROUTES (for backward compatibility) ====================

// Get user's purchase history (legacy)
app.get('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.id, p.public_id, p.quantity, p.total_price, p.status, p.created_at,
             pr.name as product_name, pr.category as product_category, pr.public_id as product_public_id
      FROM purchases p
      JOIN products pr ON p.product_id = pr.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get purchases error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a purchase (legacy)
app.post('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const { product_id, quantity = 1 } = req.body;
    
    const productResult = await db.query('SELECT id, price FROM products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = productResult.rows[0];
    const totalPrice = product.price * quantity;
    const publicId = await generatePublicId('purchases', 'ORDER');

    const result = await db.query(`
      INSERT INTO purchases (public_id, user_id, product_id, quantity, total_price, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING *
    `, [publicId, req.user.id, product_id, quantity, totalPrice]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create purchase error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all purchases (legacy)
app.get('/api/admin/purchases', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(`
      SELECT p.id, p.public_id, p.quantity, p.total_price, p.status, p.created_at,
             pr.name as product_name, pr.category as product_category, pr.public_id as product_public_id,
             u.username, u.email, u.public_id as user_public_id
      FROM purchases p
      JOIN products pr ON p.product_id = pr.id
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get all purchases error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get purchases by user (legacy)
app.get('/api/admin/users/:userId/purchases', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await db.query(`
      SELECT p.id, p.public_id, p.quantity, p.total_price, p.status, p.created_at,
             pr.name as product_name, pr.category as product_category, pr.public_id as product_public_id
      FROM purchases p
      JOIN products pr ON p.product_id = pr.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [req.params.userId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user purchases error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Update purchase status (legacy)
app.put('/api/admin/purchases/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { status } = req.body;

    const result = await db.query(`
      UPDATE purchases SET status = $1 WHERE id = $2 RETURNING *
    `, [status, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update purchase error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== HELPER FUNCTIONS ====================

// Generate public_id
async function generatePublicId(tableName, prefix) {
  const maxAttempts = 5;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Generate unique ID with timestamp + random suffix
      const timestamp = Date.now().toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      const publicId = `${prefix}-${timestamp}${random}`;
      
      // Check if it exists
      const existsResult = await db.query(
        `SELECT 1 FROM ${tableName} WHERE public_id = $1 LIMIT 1`,
        [publicId]
      );
      
      if (existsResult.rows.length === 0) {
        return publicId;
      }
      
      // If exists, try again with small delay
      await new Promise(resolve => setTimeout(resolve, 10));
    } catch (error) {
      console.error('Generate public_id error:', error);
    }
  }
  
  // Fallback: use full timestamp with microsecond-like precision
  return `${prefix}-${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== DATABASE MIGRATION ====================
// Run this once: /api/run-migration?key=lunar2025

app.get('/api/run-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add all missing user columns
    const userColumns = [
      { name: 'is_approved', type: 'BOOLEAN DEFAULT true' },
      { name: 'approved_at', type: 'TIMESTAMP' },
      { name: 'approved_by', type: 'INTEGER' },
      { name: 'avatar_base64', type: 'TEXT' },
      { name: 'is_coach', type: 'BOOLEAN DEFAULT false' },
      { name: 'is_public', type: 'BOOLEAN DEFAULT true' },
      { name: 'role', type: 'TEXT' },
      { name: 'gdpr_consent', type: 'BOOLEAN DEFAULT false' },
      { name: 'gdpr_consent_date', type: 'TIMESTAMP' },
      { name: 'birthdate', type: 'DATE' }
    ];

    for (const col of userColumns) {
      try {
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.steps.push(`✅ Added column: ${col.name}`);
      } catch (err) {
        results.steps.push(`⏭️ Column ${col.name} already exists or error: ${err.message}`);
      }
    }

    // Set existing users as approved
    results.steps.push('Setting existing users as approved...');
    await db.query(`UPDATE users SET is_approved = true WHERE is_approved IS NULL`);

    // Make sure admins are always approved
    await db.query(`UPDATE users SET is_approved = true WHERE is_admin = true`);

    // Create demo user if not exists
    try {
      const demoExists = await db.query(`SELECT id FROM users WHERE email = 'demo@demo.demo'`);
      if (demoExists.rows.length === 0) {
        const demoPassword = await bcrypt.hash('12345', 10);
        const demoPublicId = await generatePublicId('users', 'USER');
        await db.query(
          `INSERT INTO users (public_id, email, password_hash, username, is_approved, is_admin) 
           VALUES ($1, 'demo@demo.demo', $2, 'Demo User', true, false)`,
          [demoPublicId, demoPassword]
        );
        results.steps.push('✅ Created demo user (demo@demo.demo / 12345)');
      } else {
        results.steps.push('⏭️ Demo user already exists');
      }
    } catch (demoErr) {
      results.steps.push(`⚠️ Demo user creation: ${demoErr.message}`);
    }

    results.success = true;
    results.message = '✅ Migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Birthdate migration - adds default birthdate to existing users
// Run: /api/run-birthdate-migration?key=lunar2025
app.get('/api/run-birthdate-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add birthdate column if not exists
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate DATE`);
      results.steps.push('✅ Birthdate column ready');
    } catch (err) {
      results.steps.push(`⏭️ Birthdate column: ${err.message}`);
    }

    // Update existing users with default birthdate (01.01.1966)
    const updateResult = await db.query(
      `UPDATE users SET birthdate = '1966-01-01' WHERE birthdate IS NULL`
    );
    results.steps.push(`✅ Updated ${updateResult.rowCount} users with default birthdate (1966-01-01)`);

    results.success = true;
    results.message = '✅ Birthdate migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Legacy migration endpoint (redirects to new one)
app.get('/api/run-approval-migration', (req, res) => {
  res.redirect(`/api/run-migration?key=${req.query.key}`);
});

// Products migration - creates products and purchases tables
// Run: /api/run-products-migration?key=lunar2025
app.get('/api/run-products-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Create products table
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          public_id VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          category VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          description TEXT,
          duration VARCHAR(50),
          icon VARCHAR(50),
          gradient VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      results.steps.push('✅ Products table created/verified');
    } catch (err) {
      results.steps.push(`⚠️ Products table: ${err.message}`);
    }

    // Create purchases table
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS purchases (
          id SERIAL PRIMARY KEY,
          public_id VARCHAR(50) UNIQUE NOT NULL,
          user_id INTEGER REFERENCES users(id),
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER DEFAULT 1,
          total_price DECIMAL(10,2) NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      results.steps.push('✅ Purchases table created/verified');
    } catch (err) {
      results.steps.push(`⚠️ Purchases table: ${err.message}`);
    }

    // Insert default products if none exist
    const productCount = await db.query('SELECT COUNT(*) FROM products');
    if (parseInt(productCount.rows[0].count) === 0) {
      const defaultProducts = [
        // Cable passes
        { name: '1h Pass', category: 'cable', price: 25.00, description: 'One hour of cable wakeboarding. Perfect for a quick session.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '2h Pass', category: 'cable', price: 35.00, description: 'Two hours of cable wakeboarding. Great value for longer sessions.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'All Day', category: 'cable', price: 45.00, description: 'Unlimited riding for the entire day. Best value for dedicated riders.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '3 Days Pass', category: 'cable', price: 120.00, description: 'Three full days of unlimited riding. Perfect for a weekend getaway.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'Week Pass', category: 'cable', price: 250.00, description: 'Seven days of unlimited access. Ideal for serious progression.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '2 Week Pass', category: 'cable', price: 375.00, description: 'Two weeks of unlimited riding. Maximum value for extended stays.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        // Activities
        { name: 'Water Donut & Rent 2.0', category: 'activities', price: 50.00, duration: '30min', description: 'Fun water donut ride with equipment rental. Perfect for groups!', icon: '🍩', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: '2.0 Intro Class', category: 'activities', price: 45.00, duration: '1h', description: 'Beginner introduction class with certified instructor.', icon: '🏫', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'Aquaglide 1h', category: 'activities', price: 11.00, duration: '1h', description: 'Inflatable water park access for one hour of fun.', icon: '🎢', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'Kayak Single', category: 'activities', price: 11.00, duration: '1h', description: 'Single kayak rental for exploring the lake.', icon: '🛶', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'SUP 1h', category: 'activities', price: 11.00, duration: '1h', description: 'Stand-up paddleboard rental. Great workout and relaxation.', icon: '🏄', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        // Events
        { name: 'Marbella Week', category: 'events', price: 900.00, description: 'Week-long wakeboarding trip to Marbella including accommodation, coaching, and cable passes.', icon: '🌴', gradient: 'linear-gradient(135deg,#ec4899,#f43f5e)' },
        // Clothes
        { name: 'Hoodie', category: 'clothes', price: 55.00, description: 'Premium quality hoodie with Lunar Cable Park logo. Soft fleece interior, perfect for cool evenings after riding.', icon: '🧥', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)' },
        { name: 'Tank Top', category: 'clothes', price: 25.00, description: 'Breathable tank top for hot summer days. Lightweight fabric, ideal for riding sessions.', icon: '👕', gradient: 'linear-gradient(135deg,#f43f5e,#fb923c)' },
        { name: 'T-Shirt', category: 'clothes', price: 30.00, description: 'Classic cotton t-shirt with stylish Lunar design. Comfortable fit for everyday wear.', icon: '👚', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'Cap', category: 'clothes', price: 20.00, description: 'Adjustable cap with embroidered Lunar logo. Protect yourself from the sun in style.', icon: '🧢', gradient: 'linear-gradient(135deg,#10b981,#34d399)' },
      ];

      for (const product of defaultProducts) {
        try {
          const publicId = await generatePublicId('products', 'PRODUCT');
          await db.query(`
            INSERT INTO products (public_id, name, category, price, description, duration, icon, gradient, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          `, [publicId, product.name, product.category, product.price, product.description, product.duration || null, product.icon, product.gradient]);
        } catch (insertErr) {
          results.steps.push(`⚠️ Product ${product.name}: ${insertErr.message}`);
        }
      }
      results.steps.push(`✅ Inserted ${defaultProducts.length} default products`);
    } else {
      results.steps.push(`⏭️ Products already exist (${productCount.rows[0].count} products)`);
    }

    results.success = true;
    results.message = '✅ Products migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Run: /api/run-cart-migration?key=lunar2025
app.get('/api/run-cart-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Create cart_items table
    await db.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    results.steps.push('✅ Cart items table created/verified');

    results.success = true;
    results.message = '✅ Cart migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Run: /api/run-orders-migration?key=lunar2025
app.get('/api/run-orders-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add phone column to users if not exists
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
      results.steps.push('✅ Phone column added to users');
    } catch (err) {
      results.steps.push(`⚠️ Phone column: ${err.message}`);
    }

    // Add user_id column to news for personal notifications
    try {
      await db.query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
      results.steps.push('✅ User_id column added to news (for personal notifications)');
    } catch (err) {
      results.steps.push(`⚠️ News user_id column: ${err.message}`);
    }

    // Create orders table
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        public_id VARCHAR(50) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        product_category VARCHAR(50),
        amount DECIMAL(10,2) NOT NULL,
        booking_date DATE,
        booking_time VARCHAR(10),
        phone VARCHAR(30),
        shipping_address TEXT,
        status VARCHAR(50) DEFAULT 'pending_payment',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        fake BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    results.steps.push('✅ Orders table created');

    // Create index for faster queries
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_booking_date ON orders(booking_date)`);
      results.steps.push('✅ Orders indexes created');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    // Insert 5 fake orders for testing
    const existingOrders = await db.query('SELECT COUNT(*) FROM orders WHERE fake = true');
    if (parseInt(existingOrders.rows[0].count) === 0) {
      // Get first user and some products for fake orders
      const usersResult = await db.query('SELECT id FROM users LIMIT 1');
      const productsResult = await db.query('SELECT id, name, category, price FROM products LIMIT 5');
      
      if (usersResult.rows.length > 0 && productsResult.rows.length > 0) {
        const userId = usersResult.rows[0].id;
        const products = productsResult.rows;
        
        const fakeOrders = [
          { product: products[0], status: 'completed', booking_date: '2025-01-20', booking_time: '10:00', days_ago: 5 },
          { product: products[1] || products[0], status: 'completed', booking_date: '2025-01-22', booking_time: '14:00', days_ago: 3 },
          { product: products[2] || products[0], status: 'pending_shipment', booking_date: null, booking_time: null, days_ago: 2, address: 'Calle Mayor 123, Madrid, Spain' },
          { product: products[3] || products[0], status: 'completed', booking_date: '2025-01-24', booking_time: '11:00', days_ago: 1 },
          { product: products[4] || products[0], status: 'completed', booking_date: '2025-01-25', booking_time: '09:00', days_ago: 0 },
        ];

        for (let i = 0; i < fakeOrders.length; i++) {
          const fo = fakeOrders[i];
          const publicId = `ORD-FAKE${String(i + 1).padStart(3, '0')}`;
          const createdAt = new Date();
          createdAt.setDate(createdAt.getDate() - fo.days_ago);
          
          try {
            await db.query(`
              INSERT INTO orders (
                public_id, user_id, product_id, product_name, product_category,
                amount, booking_date, booking_time, shipping_address, status, fake, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
            `, [
              publicId, userId, fo.product.id, fo.product.name, fo.product.category,
              fo.product.price, fo.booking_date, fo.booking_time, fo.address || null, 
              fo.status, createdAt
            ]);
          } catch (insertErr) {
            results.steps.push(`⚠️ Fake order ${publicId}: ${insertErr.message}`);
          }
        }
        results.steps.push('✅ Inserted 5 fake orders for testing');
      } else {
        results.steps.push('⚠️ No users or products found for fake orders');
      }
    } else {
      results.steps.push(`⏭️ Fake orders already exist (${existingOrders.rows[0].count} orders)`);
    }

    results.success = true;
    results.message = '✅ Orders migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// ==================== USER LOGS MIGRATION ====================
// Run: /api/run-users-migration?key=lunar2025
app.get('/api/run-users-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add is_blocked column to users
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_blocked column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_blocked column: ${err.message}`);
    }

    // Add last_login column to users
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`);
      results.steps.push('✅ last_login column added to users');
    } catch (err) {
      results.steps.push(`⚠️ last_login column: ${err.message}`);
    }

    // Create user_logins table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_logins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255),
        login_time TIMESTAMP DEFAULT NOW(),
        ip_address VARCHAR(50),
        user_agent TEXT,
        success BOOLEAN DEFAULT true
      )
    `);
    results.steps.push('✅ user_logins table created');

    // Create indexes
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_logins_user_id ON user_logins(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_logins_time ON user_logins(login_time DESC)`);
      results.steps.push('✅ Indexes created for user_logins');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Users migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// ==================== ADMIN: USER DETAILS ====================

// Get user's orders (for admin)
app.get('/api/admin/users/:id/orders', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    const result = await db.query(`
      SELECT id, public_id, product_name, product_category, amount, 
             booking_date, booking_time, status, shipping_address, phone, created_at
      FROM orders 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's events (registrations)
app.get('/api/admin/users/:id/events', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    const result = await db.query(`
      SELECT e.id, e.public_id, e.name as title, e.date, e.time, e.location, 
             ea.created_at as registered_at
      FROM event_attendees ea
      JOIN events e ON e.id = ea.event_id
      WHERE ea.user_id = $1
      ORDER BY e.date DESC
    `, [userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get user events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's login history
app.get('/api/admin/users/:id/logins', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    const result = await db.query(`
      SELECT id, login_time, ip_address, user_agent, success
      FROM user_logins 
      WHERE user_id = $1 
      ORDER BY login_time DESC
      LIMIT 100
    `, [userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get user logins error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block user
app.post('/api/admin/users/:id/block', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    
    // Prevent blocking yourself
    if (parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    await db.query('UPDATE users SET is_blocked = true WHERE id = $1', [userId]);
    res.json({ success: true, message: 'User blocked' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unblock user
app.post('/api/admin/users/:id/unblock', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    await db.query('UPDATE users SET is_blocked = false WHERE id = $1', [userId]);
    res.json({ success: true, message: 'User unblocked' });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user roles (Coach, Staff, Club Member)
app.patch('/api/admin/users/:id/roles', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userId = req.params.id;
    const { is_coach, is_staff, is_club_member } = req.body;

    // Try with all columns first
    try {
      await db.query(`
        UPDATE users 
        SET is_coach = COALESCE($1, is_coach),
            is_staff = COALESCE($2, is_staff),
            is_club_member = COALESCE($3, is_club_member)
        WHERE id = $4
      `, [is_coach, is_staff, is_club_member, userId]);
    } catch (queryErr) {
      // Fallback to just is_coach if new columns don't exist
      console.log('Roles update fallback - columns may not exist:', queryErr.message);
      await db.query(`UPDATE users SET is_coach = COALESCE($1, is_coach) WHERE id = $2`, [is_coach, userId]);
    }

    res.json({ success: true, message: 'User roles updated' });
  } catch (error) {
    console.error('Update user roles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ACHIEVEMENTS SYSTEM ====================

// Achievement definitions
const ACHIEVEMENTS = {
  // Automatic achievements with tiers
  trick_master: {
    id: 'trick_master',
    name: 'Trick Master',
    icon: '🏆',
    description: 'Master wakeboard tricks',
    type: 'automatic',
    tiers: { bronze: 1, silver: 10, gold: 25, platinum: 50 },
    category: 'tricks'
  },
  knowledge_seeker: {
    id: 'knowledge_seeker',
    name: 'Knowledge Seeker',
    icon: '📚',
    description: 'Read articles to learn',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 },
    category: 'articles'
  },
  event_enthusiast: {
    id: 'event_enthusiast',
    name: 'Event Enthusiast',
    icon: '📅',
    description: 'Join events and sessions',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 },
    category: 'events'
  },
  loyal_friend: {
    id: 'loyal_friend',
    name: 'Loyal Friend',
    icon: '💜',
    description: 'Make purchases at Lunar',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 },
    category: 'orders'
  },
  veteran: {
    id: 'veteran',
    name: 'Veteran',
    icon: '⏳',
    description: 'Days since registration',
    type: 'automatic',
    tiers: { bronze: 7, silver: 30, gold: 90, platinum: 365 },
    category: 'account'
  },
  surface_pro: {
    id: 'surface_pro',
    name: 'Surface Pro',
    icon: '🌊',
    description: 'Master surface tricks',
    type: 'automatic',
    tiers: { bronze: 1, silver: 3, gold: 6, platinum: 10 },
    category: 'tricks_surface'
  },
  air_acrobat: {
    id: 'air_acrobat',
    name: 'Air Acrobat',
    icon: '✈️',
    description: 'Master air tricks',
    type: 'automatic',
    tiers: { bronze: 1, silver: 3, gold: 6, platinum: 10 },
    category: 'tricks_air'
  },
  rail_rider: {
    id: 'rail_rider',
    name: 'Rail Rider',
    icon: '🛹',
    description: 'Master rail tricks',
    type: 'automatic',
    tiers: { bronze: 1, silver: 2, gold: 4, platinum: 6 },
    category: 'tricks_rail'
  },
  kicker_king: {
    id: 'kicker_king',
    name: 'Kicker King',
    icon: '🚀',
    description: 'Master kicker tricks',
    type: 'automatic',
    tiers: { bronze: 1, silver: 2, gold: 4, platinum: 6 },
    category: 'tricks_kicker'
  },
  profile_pro: {
    id: 'profile_pro',
    name: 'Profile Pro',
    icon: '👤',
    description: 'Complete your profile with avatar',
    type: 'automatic',
    tiers: { platinum: 1 }, // Only platinum tier
    category: 'profile'
  },
  dedicated_rider: {
    id: 'dedicated_rider',
    name: 'Dedicated Rider',
    icon: '🔥',
    description: 'Login streak days',
    type: 'automatic',
    tiers: { bronze: 3, silver: 7, gold: 14, platinum: 30 },
    category: 'streak'
  },
  // Manual achievements (single tier - awarded by admin)
  wings4life: {
    id: 'wings4life',
    name: 'Wings 4 Life',
    icon: '🦅',
    description: 'Participated in Wings 4 Life event',
    type: 'manual',
    tiers: { special: 1 },
    category: 'special'
  },
  vip_guest: {
    id: 'vip_guest',
    name: 'VIP Guest',
    icon: '⭐',
    description: 'Special guest or influencer',
    type: 'manual',
    tiers: { special: 1 },
    category: 'special'
  },
  camp_graduate: {
    id: 'camp_graduate',
    name: 'Camp Graduate',
    icon: '🎓',
    description: 'Completed wakeboard camp',
    type: 'manual',
    tiers: { special: 1 },
    category: 'special'
  },
  competition_winner: {
    id: 'competition_winner',
    name: 'Competition Winner',
    icon: '🏅',
    description: 'Won a wakeboard competition',
    type: 'manual',
    tiers: { special: 1 },
    category: 'special'
  }
};

// Get all achievement definitions
app.get('/api/achievements', (req, res) => {
  res.json(ACHIEVEMENTS);
});

// Calculate user's achievement progress
async function calculateUserAchievements(userId) {
  const results = {};
  
  try {
    // Get user data
    const userResult = await db.query('SELECT created_at, avatar_base64 FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return results;
    const user = userResult.rows[0];
    
    // Tricks mastered (total and by category)
    const tricksResult = await db.query(`
      SELECT t.category, COUNT(*) as count
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1 AND ut.status = 'mastered'
      GROUP BY t.category
    `, [userId]);
    
    let totalMastered = 0;
    const tricksByCategory = {};
    tricksResult.rows.forEach(row => {
      tricksByCategory[row.category] = parseInt(row.count);
      totalMastered += parseInt(row.count);
    });
    
    results.trick_master = totalMastered;
    results.surface_pro = tricksByCategory['surface'] || 0;
    results.air_acrobat = tricksByCategory['air'] || 0;
    results.rail_rider = tricksByCategory['rail'] || 0;
    results.kicker_king = tricksByCategory['kicker'] || 0;
    
    // Articles read
    const articlesResult = await db.query(`
      SELECT COUNT(*) as count FROM user_articles 
      WHERE user_id = $1 AND status = 'known'
    `, [userId]);
    results.knowledge_seeker = parseInt(articlesResult.rows[0]?.count || 0);
    
    // Events joined
    const eventsResult = await db.query(`
      SELECT COUNT(*) as count FROM event_attendees WHERE user_id = $1
    `, [userId]);
    results.event_enthusiast = parseInt(eventsResult.rows[0]?.count || 0);
    
    // Orders completed
    const ordersResult = await db.query(`
      SELECT COUNT(*) as count FROM orders 
      WHERE user_id = $1 AND status IN ('completed', 'shipped', 'pending_shipment') AND fake = false
    `, [userId]);
    results.loyal_friend = parseInt(ordersResult.rows[0]?.count || 0);
    
    // Days since registration
    const daysSinceReg = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
    results.veteran = daysSinceReg;
    
    // Profile completed (has avatar)
    results.profile_pro = user.avatar_base64 ? 1 : 0;
    
    // Login streak
    const streakResult = await db.query(`
      SELECT DATE(login_time) as login_date
      FROM user_logins
      WHERE user_id = $1 AND success = true
      GROUP BY DATE(login_time)
      ORDER BY login_date DESC
    `, [userId]);
    
    let streak = 0;
    if (streakResult.rows.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      let expectedDate = today;
      for (const row of streakResult.rows) {
        const loginDate = new Date(row.login_date);
        loginDate.setHours(0, 0, 0, 0);
        
        const diffDays = Math.floor((expectedDate - loginDate) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0 || diffDays === 1) {
          streak++;
          expectedDate = loginDate;
          expectedDate.setDate(expectedDate.getDate() - 1);
        } else {
          break;
        }
      }
    }
    results.dedicated_rider = streak;
    
  } catch (err) {
    console.error('Error calculating achievements:', err);
  }
  
  return results;
}

// Determine tier based on value and thresholds
function determineTier(value, tiers) {
  if (tiers.special !== undefined) {
    return value >= tiers.special ? 'special' : null;
  }
  if (tiers.platinum !== undefined && value >= tiers.platinum) return 'platinum';
  if (tiers.gold !== undefined && value >= tiers.gold) return 'gold';
  if (tiers.silver !== undefined && value >= tiers.silver) return 'silver';
  if (tiers.bronze !== undefined && value >= tiers.bronze) return 'bronze';
  return null;
}

// Get user's achievements
app.get('/api/achievements/my', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get current progress
    const progress = await calculateUserAchievements(userId);
    
    // Get stored achievements
    const storedResult = await db.query(
      'SELECT achievement_id, tier, achieved_at FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    const stored = {};
    storedResult.rows.forEach(row => {
      stored[row.achievement_id] = { tier: row.tier, achieved_at: row.achieved_at };
    });
    
    // Get manual achievements
    const manualResult = await db.query(
      'SELECT achievement_id, awarded_at, note FROM user_manual_achievements WHERE user_id = $1',
      [userId]
    );
    const manual = {};
    manualResult.rows.forEach(row => {
      manual[row.achievement_id] = { awarded_at: row.awarded_at, note: row.note };
    });
    
    // Build response
    const achievements = {};
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      if (def.type === 'automatic') {
        const value = progress[id] || 0;
        const currentTier = determineTier(value, def.tiers);
        achievements[id] = {
          ...def,
          progress: value,
          currentTier,
          storedTier: stored[id]?.tier || null,
          achievedAt: stored[id]?.achieved_at || null
        };
      } else {
        // Manual achievement
        achievements[id] = {
          ...def,
          currentTier: manual[id] ? 'special' : null,
          achievedAt: manual[id]?.awarded_at || null,
          note: manual[id]?.note || null
        };
      }
    }
    
    // Calculate stats - count tiers earned (each achievement has 4 tiers)
    const autoAchievements = Object.values(achievements).filter(a => a.type === 'automatic');
    const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
    
    // Count total tiers earned (e.g., gold = 3 tiers: bronze, silver, gold)
    let earnedTiers = 0;
    autoAchievements.forEach(a => {
      if (a.currentTier) {
        earnedTiers += tierOrder.indexOf(a.currentTier) + 1;
      }
    });
    
    const totalTiers = autoAchievements.length * 4; // 11 × 4 = 44
    const specialCount = Object.values(achievements).filter(a => a.type === 'manual' && a.currentTier === 'special').length;
    
    res.json({
      achievements,
      stats: {
        earned: earnedTiers,
        total: totalTiers,
        special: specialCount,
        streak: progress.dedicated_rider || 0
      }
    });
  } catch (error) {
    console.error('Get my achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Check and update achievements (called after actions)
app.post('/api/achievements/check', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const progress = await calculateUserAchievements(userId);
    const newAchievements = [];
    
    // Get current stored achievements
    const storedResult = await db.query(
      'SELECT achievement_id, tier FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    const stored = {};
    storedResult.rows.forEach(row => {
      stored[row.achievement_id] = row.tier;
    });
    
    const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
    
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      if (def.type !== 'automatic') continue;
      
      const value = progress[id] || 0;
      const newTier = determineTier(value, def.tiers);
      const oldTier = stored[id] || null;
      
      if (newTier && newTier !== oldTier) {
        // Check if it's an upgrade
        const oldIndex = oldTier ? tierOrder.indexOf(oldTier) : -1;
        const newIndex = tierOrder.indexOf(newTier);
        
        if (newIndex > oldIndex) {
          // Upsert achievement
          await db.query(`
            INSERT INTO user_achievements (user_id, achievement_id, tier, achieved_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (user_id, achievement_id)
            DO UPDATE SET tier = $3, achieved_at = NOW()
          `, [userId, id, newTier]);
          
          newAchievements.push({ id, name: def.name, icon: def.icon, tier: newTier });
          
          // Create news notification for user
          const tierEmoji = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎' };
          const newsPublicId = await generatePublicId('news', 'NEWS');
          await db.query(`
            INSERT INTO news (public_id, title, message, type, emoji, user_id)
            VALUES ($1, $2, $3, 'achievement', $4, $5)
          `, [
            newsPublicId,
            `Achievement Unlocked: ${def.name}! ${tierEmoji[newTier] || '🏆'}`,
            `Congratulations! You earned the ${newTier.toUpperCase()} tier of "${def.name}" achievement!`,
            def.icon,
            userId
          ]);
        }
      }
    }
    
    res.json({ newAchievements, checked: true });
  } catch (error) {
    console.error('Check achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's achievements (public - for crew profile)
app.get('/api/users/:id/achievements', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get stored achievements
    const storedResult = await db.query(
      'SELECT achievement_id, tier, achieved_at FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    
    // Get manual achievements
    const manualResult = await db.query(
      'SELECT achievement_id, awarded_at FROM user_manual_achievements WHERE user_id = $1',
      [userId]
    );
    
    const achievements = [];
    
    storedResult.rows.forEach(row => {
      const def = ACHIEVEMENTS[row.achievement_id];
      if (def) {
        achievements.push({
          id: row.achievement_id,
          name: def.name,
          icon: def.icon,
          tier: row.tier,
          achievedAt: row.achieved_at
        });
      }
    });
    
    manualResult.rows.forEach(row => {
      const def = ACHIEVEMENTS[row.achievement_id];
      if (def) {
        achievements.push({
          id: row.achievement_id,
          name: def.name,
          icon: def.icon,
          tier: 'special',
          achievedAt: row.awarded_at
        });
      }
    });
    
    res.json(achievements);
  } catch (error) {
    console.error('Get user achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user stats (public - for crew profile)
app.get('/api/users/:id/stats', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Tricks
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
      FROM user_tricks WHERE user_id = $1
    `, [userId]);
    
    // Articles
    const articlesResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'known') as read,
        COUNT(*) FILTER (WHERE status = 'to_read') as to_read
      FROM user_articles WHERE user_id = $1
    `, [userId]);
    
    // Events
    const eventsResult = await db.query(
      'SELECT COUNT(*) as count FROM event_attendees WHERE user_id = $1',
      [userId]
    );
    
    // Bookings
    const bookingsResult = await db.query(`
      SELECT COUNT(*) as count FROM orders 
      WHERE user_id = $1 AND booking_date IS NOT NULL AND status IN ('completed', 'shipped', 'pending_shipment')
    `, [userId]);
    
    res.json({
      tricks: {
        mastered: parseInt(tricksResult.rows[0]?.mastered || 0),
        inProgress: parseInt(tricksResult.rows[0]?.in_progress || 0)
      },
      articles: {
        read: parseInt(articlesResult.rows[0]?.read || 0),
        toRead: parseInt(articlesResult.rows[0]?.to_read || 0)
      },
      events: parseInt(eventsResult.rows[0]?.count || 0),
      bookings: parseInt(bookingsResult.rows[0]?.count || 0)
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN: ACHIEVEMENTS ====================

// Get achievements statistics
app.get('/api/admin/achievements/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    // Count users per achievement per tier
    let autoResult = { rows: [] };
    let manualResult = { rows: [] };
    
    try {
      autoResult = await db.query(`
        SELECT achievement_id, tier, COUNT(*) as count
        FROM user_achievements
        GROUP BY achievement_id, tier
        ORDER BY achievement_id, tier
      `);
    } catch (err) {
      console.log('user_achievements table may not exist:', err.message);
    }
    
    try {
      manualResult = await db.query(`
        SELECT achievement_id, COUNT(*) as count
        FROM user_manual_achievements
        GROUP BY achievement_id
      `);
    } catch (err) {
      console.log('user_manual_achievements table may not exist:', err.message);
    }
    
    const stats = {};
    
    // Initialize all achievements
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      stats[id] = {
        ...def,
        tiers: {
          bronze: 0,
          silver: 0,
          gold: 0,
          platinum: 0,
          special: 0
        }
      };
    }
    
    // Fill in auto achievements
    autoResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers[row.tier] = parseInt(row.count);
      }
    });
    
    // Fill in manual achievements
    manualResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers.special = parseInt(row.count);
      }
    });
    
    // Return as array
    res.json(Object.values(stats));
  } catch (error) {
    console.error('Get achievements stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Grant manual achievement to user
app.post('/api/admin/users/:id/grant-achievement', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const userId = req.params.id;
    const { achievement_id, note } = req.body;
    
    if (!achievement_id) {
      return res.status(400).json({ error: 'achievement_id is required' });
    }
    
    // Verify it's a manual achievement
    const def = ACHIEVEMENTS[achievement_id];
    if (!def || def.type !== 'manual') {
      return res.status(400).json({ error: 'Invalid manual achievement' });
    }
    
    // Check if already granted
    try {
      const existing = await db.query(
        'SELECT id FROM user_manual_achievements WHERE user_id = $1 AND achievement_id = $2',
        [userId, achievement_id]
      );
      
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Achievement already granted' });
      }
    } catch (tableErr) {
      // Table might not exist, try to create it
      console.log('user_manual_achievements table may not exist, creating...');
      await db.query(`
        CREATE TABLE IF NOT EXISTS user_manual_achievements (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          achievement_id VARCHAR(50) NOT NULL,
          awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          awarded_at TIMESTAMP DEFAULT NOW(),
          note TEXT,
          UNIQUE(user_id, achievement_id)
        )
      `);
    }
    
    // Grant achievement
    await db.query(`
      INSERT INTO user_manual_achievements (user_id, achievement_id, awarded_by, awarded_at, note)
      VALUES ($1, $2, $3, NOW(), $4)
    `, [userId, achievement_id, req.user.id, note || null]);
    
    // Create news notification
    try {
      const newsPublicId = await generatePublicId('news', 'NEWS');
      await db.query(`
        INSERT INTO news (public_id, title, message, type, emoji, user_id)
        VALUES ($1, $2, $3, 'achievement', $4, $5)
      `, [
        newsPublicId,
        `Special Achievement: ${def.name}! ⭐`,
        `Congratulations! You've been awarded the "${def.name}" special achievement!`,
        def.icon,
        userId
      ]);
    } catch (newsErr) {
      console.log('Could not create news notification:', newsErr.message);
    }
    
    res.json({ success: true, message: 'Achievement granted' });
  } catch (error) {
    console.error('Grant achievement error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Revoke manual achievement from user
app.delete('/api/admin/users/:id/revoke-achievement/:achievementId', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { id: userId, achievementId } = req.params;
    
    await db.query(
      'DELETE FROM user_manual_achievements WHERE user_id = $1 AND achievement_id = $2',
      [userId, achievementId]
    );
    
    res.json({ success: true, message: 'Achievement revoked' });
  } catch (error) {
    console.error('Revoke achievement error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's manual achievements (for admin)
app.get('/api/admin/users/:id/manual-achievements', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const userId = req.params.id;
    
    try {
      const result = await db.query(`
        SELECT ma.achievement_id as id, ma.awarded_at, ma.note, u.username as awarded_by_username
        FROM user_manual_achievements ma
        LEFT JOIN users u ON ma.awarded_by = u.id
        WHERE ma.user_id = $1
      `, [userId]);
      
      // Enrich with achievement definition
      const achievements = result.rows.map(row => ({
        ...row,
        ...ACHIEVEMENTS[row.id],
      }));
      
      res.json(achievements);
    } catch (tableErr) {
      // Table might not exist
      console.log('user_manual_achievements table may not exist:', tableErr.message);
      res.json([]);
    }
  } catch (error) {
    console.error('Get user manual achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ACHIEVEMENTS MIGRATION ====================
// Run: /api/run-achievements-migration?key=lunar2025
app.get('/api/run-achievements-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add is_staff column to users
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_staff column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_staff column: ${err.message}`);
    }

    // Add is_club_member column to users
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_club_member BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_club_member column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_club_member column: ${err.message}`);
    }

    // Create user_achievements table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        achievement_id VARCHAR(50) NOT NULL,
        tier VARCHAR(20) NOT NULL,
        achieved_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, achievement_id)
      )
    `);
    results.steps.push('✅ user_achievements table created');

    // Create user_manual_achievements table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_manual_achievements (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        achievement_id VARCHAR(50) NOT NULL,
        awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        awarded_at TIMESTAMP DEFAULT NOW(),
        note TEXT,
        UNIQUE(user_id, achievement_id)
      )
    `);
    results.steps.push('✅ user_manual_achievements table created');

    // Create indexes
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id ON user_achievements(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_manual_achievements_user_id ON user_manual_achievements(user_id)`);
      results.steps.push('✅ Indexes created for achievements tables');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Achievements migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// ==================== START SERVER ====================
const startServer = async () => {
  try {
    await db.initDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 WakeWay API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
