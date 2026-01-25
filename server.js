const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

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
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

    // Check if user exists
    const existing = await db.query('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email or username already exists' });
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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is approved (skip check if column doesn't exist or is null - for backwards compatibility)
    if (user.is_approved === false && !user.is_admin) {
      return res.status(403).json({ 
        error: 'Your account is pending admin approval. Please wait for confirmation.',
        pending_approval: true
      });
    }

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
    const result = await db.query('SELECT id, public_id, email, username, is_admin FROM users WHERE id = $1', [decoded.userId]);
    
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
        SELECT id, public_id, username, display_name, avatar_base64, is_coach, role,
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

    // Show only approved users (or admins, or users with NULL is_approved for backwards compatibility)
    const result = await db.query(`
      SELECT id, public_id, email, username, display_name, birthdate, is_admin, is_approved, created_at 
      FROM users 
      WHERE is_approved = true OR is_approved IS NULL OR is_admin = true
      ORDER BY created_at DESC
    `);
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
    const result = await db.query('SELECT * FROM news ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN NEWS ROUTES ====================

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

// ==================== PURCHASES/ORDERS ROUTES ====================

// Get user's purchase history
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

// Create a purchase (for future use)
app.post('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const { product_id, quantity = 1 } = req.body;
    
    // Get product price
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

// Admin: Get all purchases
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

// Admin: Get purchases by user
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

// Admin: Update purchase status
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
  try {
    const result = await db.query(
      `SELECT public_id FROM ${tableName} WHERE public_id LIKE $1 ORDER BY public_id DESC LIMIT 1`,
      [`${prefix}-%`]
    );
    
    let nextNum = 1;
    if (result.rows.length > 0 && result.rows[0].public_id) {
      const currentNum = parseInt(result.rows[0].public_id.split('-')[1], 10);
      nextNum = currentNum + 1;
    }
    
    return `${prefix}-${String(nextNum).padStart(5, '0')}`;
  } catch (error) {
    console.error('Generate public_id error:', error);
    return `${prefix}-${Date.now()}`;
  }
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
