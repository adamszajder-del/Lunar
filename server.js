const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*', // Pozwól na połączenia z każdej domeny (frontend na home.pl)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ==================== AUTH ROUTES ====================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'wakeway-secret-key-change-in-production';

// Register - with approval system
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username, gdpr_consent } = req.body;
    
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

    // Create user with is_approved = false (requires admin approval)
    const result = await db.query(
      `INSERT INTO users (public_id, email, password_hash, username, gdpr_consent, gdpr_consent_date, is_approved, created_at) 
       VALUES ($1, $2, $3, $4, $5, NOW(), false, NOW()) 
       RETURNING id, public_id, email, username, is_approved`,
      [publicId, email, passwordHash, username, gdpr_consent || false]
    );

    const user = result.rows[0];

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

// Login - with approval check
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is approved (admins are always allowed)
    if (!user.is_approved && !user.is_admin) {
      return res.status(403).json({ 
        error: 'Your account is pending admin approval. Please wait for confirmation.',
        pending_approval: true
      });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        username: user.username,
        display_name: user.display_name,
        is_admin: user.is_admin,
        is_coach: user.is_coach,
        avatar_base64: user.avatar_base64
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
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

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ==================== USER PROFILE ROUTES ====================

// Update user profile (email/password)
app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const { email, password } = req.body;
    const userId = req.user.id;

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
    res.status(500).json({ error: 'Server error' });
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
             u.username as author_name,
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

// ==================== ADMIN EVENTS ROUTES ====================

// Get all events (admin)
app.get('/api/admin/events', async (req, res) => {
  try {
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
    const result = await db.query(`
      SELECT id, public_id, username, display_name, avatar_base64
      FROM users
      ORDER BY username
    `);
    
    // Add default values for missing fields
    const users = result.rows.map(u => ({
      ...u,
      is_coach: false,
      role: null,
      mastered: 0,
      in_progress: 0
    }));
    
    res.json(users);
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

    const result = await db.query(`
      SELECT id, public_id, email, username, display_name, is_admin, is_approved, created_at 
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
// Run this once to add approval columns: /api/run-approval-migration?key=lunar2025

app.get('/api/run-approval-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const results = { steps: [], errors: [] };

  try {
    // Add approval columns
    results.steps.push('Adding is_approved column...');
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false`);
    
    results.steps.push('Adding approved_at column...');
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    
    results.steps.push('Adding approved_by column...');
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by INTEGER`);

    // Set existing users as approved
    results.steps.push('Setting existing users as approved...');
    const updated = await db.query(`UPDATE users SET is_approved = true WHERE is_approved IS NULL OR is_approved = false`);
    results.steps.push(`Updated ${updated.rowCount} users`);

    // Make sure admins are always approved
    results.steps.push('Ensuring admins are approved...');
    await db.query(`UPDATE users SET is_approved = true WHERE is_admin = true`);

    results.success = true;
    results.message = '✅ Migration completed! All existing users are now approved.';
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
