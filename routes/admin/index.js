// Admin Routes - /api/admin/*
const express = require('express');
const router = express.Router();
const db = require('../../database');
const bcrypt = require('bcryptjs');
const { authMiddleware, adminMiddleware, invalidateUserCache } = require('../../middleware/auth');
const { generatePublicId } = require('../../utils/publicId');
const { sendEmail, templates } = require('../../utils/email');
const { cache } = require('../../utils/cache');
const { logAction, getHistory } = require('../../utils/audit');
const { sanitizeHtml, sanitizeUrl, sanitizeString, sanitizeNumber, sanitizeDate, sanitizeTime, validateUsername } = require('../../utils/validators');

// Middleware: all admin routes require admin
router.use(authMiddleware);
router.use(adminMiddleware);

// ==================== USERS ====================

// Get all users — Fix #10: pagination
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const result = await db.query(`
      SELECT id, public_id, email, username, display_name, avatar_base64,
             is_admin, is_coach, is_staff, is_club_member, is_approved, is_blocked,
             birthdate, created_at, last_login
      FROM users ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pending users
router.get('/pending-users', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, email, username, created_at
      FROM users WHERE is_approved = false
      ORDER BY created_at ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get pending users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve user
router.post('/approve-user/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET is_approved = true WHERE id = $1 RETURNING email, username',
      [req.params.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Send approval email
    const user = result.rows[0];
    sendEmail(user.email, templates.accountApproved(user.username));
    
    res.json({ success: true, message: 'User approved' });
    await logAction('user', parseInt(req.params.userId), 'approved', req.user, user.username);
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject user
router.delete('/reject-user/:userId', async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = $1 AND is_approved = false', [req.params.userId]);
    await logAction('user', parseInt(req.params.userId), 'rejected', req.user);
    res.json({ success: true });
  } catch (error) {
    console.error('Reject user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block user
router.post('/users/:id/block', async (req, res) => {
  try {
    await db.query('UPDATE users SET is_blocked = true WHERE id = $1', [req.params.id]);
    invalidateUserCache(req.params.id);
    await logAction('user', parseInt(req.params.id), 'blocked', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Unblock user
router.post('/users/:id/unblock', async (req, res) => {
  try {
    await db.query('UPDATE users SET is_blocked = false WHERE id = $1', [req.params.id]);
    invalidateUserCache(req.params.id);
    await logAction('user', parseInt(req.params.id), 'unblocked', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user roles
router.patch('/users/:id/roles', async (req, res) => {
  try {
    const { is_coach, is_staff, is_club_member } = req.body;
    await db.query(`
      UPDATE users 
      SET is_coach = COALESCE($1, is_coach),
          is_staff = COALESCE($2, is_staff),
          is_club_member = COALESCE($3, is_club_member)
      WHERE id = $4
    `, [is_coach, is_staff, is_club_member, req.params.id]);
    invalidateUserCache(req.params.id);
    await logAction('user', parseInt(req.params.id), 'roles_changed', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (full edit from admin panel)
router.put('/users/:id', async (req, res) => {
  try {
    const username = req.body.username ? sanitizeString(req.body.username, 50) : undefined;
    const email = req.body.email ? sanitizeString(req.body.email, 255).toLowerCase() : undefined;
    const password = req.body.password;
    const { is_admin, is_coach, is_staff, is_club_member } = req.body;
    const birthdate = req.body.birthdate ? sanitizeDate(req.body.birthdate) : undefined;
    const userId = req.params.id;

    // Validate username format
    if (username) {
      const usernameCheck = validateUsername(username);
      if (!usernameCheck.valid) {
        return res.status(400).json({ error: usernameCheck.errors[0] });
      }
    }

    // Check user exists
    const existing = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check email uniqueness (exclude current user)
    if (email) {
      const emailCheck = await db.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, userId]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    // Check username uniqueness (exclude current user)
    if (username) {
      const usernameCheck = await db.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, userId]);
      if (usernameCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Username already taken' });
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (username !== undefined) { updates.push(`username = $${paramIndex++}`); values.push(username); }
    if (email !== undefined) { updates.push(`email = $${paramIndex++}`); values.push(email); }
    if (is_admin !== undefined) { updates.push(`is_admin = $${paramIndex++}`); values.push(is_admin); }
    if (is_coach !== undefined) { updates.push(`is_coach = $${paramIndex++}`); values.push(is_coach); }
    if (is_staff !== undefined) { updates.push(`is_staff = $${paramIndex++}`); values.push(is_staff); }
    if (is_club_member !== undefined) { updates.push(`is_club_member = $${paramIndex++}`); values.push(is_club_member); }
    if (birthdate !== undefined) { updates.push(`birthdate = $${paramIndex++}`); values.push(birthdate || null); }

    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(passwordHash);
      updates.push(`password_changed_at = NOW()`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(userId);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);
    await logAction('user', parseInt(userId), 'updated', req.user);
    res.json({ success: true });
  } catch (error) {
    console.error('Admin update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (from admin panel)
router.post('/users', async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 50);
    const email = sanitizeString(req.body.email, 255).toLowerCase();
    const password = req.body.password;
    const { is_admin, is_coach, is_staff, is_club_member } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email and password are required' });
    }

    // Validate username format
    const usernameValid = validateUsername(username);
    if (!usernameValid.valid) {
      return res.status(400).json({ error: usernameValid.errors[0] });
    }

    // Check email uniqueness
    const emailCheck = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Check username uniqueness
    const usernameCheck = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const publicId = await generatePublicId('users', 'USER');

    const result = await db.query(
      `INSERT INTO users (public_id, email, password_hash, username, is_admin, is_coach, is_staff, is_club_member, is_approved, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
       RETURNING id, public_id, email, username`,
      [publicId, email, passwordHash, username, is_admin || false, is_coach || false, is_staff || false, is_club_member || false]
    );

    res.status(201).json({ success: true, user: result.rows[0] });
    await logAction('user', result.rows[0].id, 'created', req.user, username);
  } catch (error) {
    console.error('Admin create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    // Prevent self-delete
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    // Fix #9: ON DELETE CASCADE handles user_id FK rows, but favorites.item_id has no FK
    // So we clean up favorites where this user was the favorited person
    await db.query("DELETE FROM favorites WHERE item_type = 'user' AND item_id = $1", [req.params.id]);
    await logAction('user', parseInt(req.params.id), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== TRICKS ====================

router.post('/tricks', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 100);
    const category = sanitizeString(req.body.category, 50);
    const difficulty = sanitizeString(req.body.difficulty, 30);
    const description = sanitizeString(req.body.description, 500);
    const full_description = sanitizeString(req.body.full_description, 5000);
    const video_url = sanitizeUrl(req.body.video_url);
    const image_url = sanitizeUrl(req.body.image_url);
    const sections = req.body.sections;
    const position = sanitizeNumber(req.body.position, 0, 9999);

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const publicId = await generatePublicId('tricks', 'TRICK');
    let result;
    try {
      result = await db.query(
        `INSERT INTO tricks (public_id, name, category, difficulty, description, full_description, video_url, image_url, sections, position) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [publicId, name, category, difficulty, description, full_description, video_url || null, image_url || null, JSON.stringify(sections || []), position]
      );
    } catch (colErr) {
      console.warn('Trick POST fallback (run migration!):', colErr.message);
      result = await db.query(
        `INSERT INTO tricks (public_id, name, category, difficulty, description, full_description, video_url) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [publicId, name, category, difficulty, description || '', full_description || '', video_url || null]
      );
    }
    const trick = result.rows[0];
    if (!trick) return res.status(500).json({ error: 'Insert returned no data' });
    cache.invalidatePrefix('tricks');
    await logAction('trick', trick.id, 'created', req.user, trick.name);
    res.json(trick);
  } catch (error) {
    console.error('Create trick error:', error);
    res.status(500).json({ error: 'Create failed: ' + error.message });
  }
});

router.put('/tricks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid trick ID' });
    
    const { name, category, difficulty, description, full_description, video_url, image_url, sections, position } = req.body;
    const sName = sanitizeString(name, 100);
    const sCat = sanitizeString(category, 50);
    const sDiff = sanitizeString(difficulty, 30);
    const sDesc = sanitizeString(description, 500);
    const sFull = sanitizeString(full_description, 5000);
    const sVideo = sanitizeUrl(video_url);
    const sImage = sanitizeUrl(image_url);
    const sPos = sanitizeNumber(position, 0, 9999);
    let result;
    try {
      result = await db.query(
        `UPDATE tricks SET name = $1, category = $2, difficulty = $3, description = $4, full_description = $5, video_url = $6, image_url = $7, sections = $8, position = $9
         WHERE id = $10 RETURNING *`,
        [sName, sCat, sDiff, sDesc, sFull, sVideo, sImage || null, JSON.stringify(sections || []), sPos, id]
      );
    } catch (colErr) {
      console.warn('Trick PUT fallback (run migration!):', colErr.message);
      result = await db.query(
        `UPDATE tricks SET name = $1, category = $2, difficulty = $3, description = $4, full_description = $5, video_url = $6
         WHERE id = $7 RETURNING *`,
        [sName, sCat, sDiff, sDesc, sFull, sVideo, id]
      );
    }
    const trick = result.rows[0];
    if (!trick) return res.status(404).json({ error: 'Trick not found (id=' + id + ')' });
    cache.invalidatePrefix('tricks');
    await logAction('trick', trick.id, 'updated', req.user, trick.name);
    res.json(trick);
  } catch (error) {
    console.error('Update trick error:', error);
    res.status(500).json({ error: 'Update failed: ' + error.message });
  }
});

router.delete('/tricks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid trick ID' });
    
    // Cleanup all possible related records before deleting trick
    const cleanupTables = [
      "DELETE FROM favorites WHERE item_type = 'trick' AND item_id = $1",
      'DELETE FROM user_tricks WHERE trick_id = $1',
      'DELETE FROM trick_comments WHERE trick_id = $1',
    ];
    for (const sql of cleanupTables) {
      try { await db.query(sql, [id]); } catch (e) { /* table may not exist */ }
    }
    const result = await db.query('DELETE FROM tricks WHERE id = $1 RETURNING id', [id]);
    cache.invalidatePrefix('tricks');
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trick not found' });
    await logAction('trick', id, 'deleted', req.user);
    res.json({ success: true, deleted: id });
  } catch (error) {
    console.error('Delete trick error:', error);
    res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
});

// ==================== EVENTS ====================

router.get('/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, u.username as author_username,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/events', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 200);
    const date = sanitizeDate(req.body.date);
    const time = sanitizeTime(req.body.time);
    const location = sanitizeString(req.body.location, 200);
    const location_url = sanitizeUrl(req.body.location_url);
    const spots = sanitizeNumber(req.body.spots, 1, 999);

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const publicId = await generatePublicId('events', 'EVENT');
    const result = await db.query(
      `INSERT INTO events (public_id, name, date, time, location, location_url, spots, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, date, time, location, location_url || null, spots, req.user.id]
    );
    await logAction('event', result.rows[0].id, 'created', req.user, name);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/events/:id', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 200);
    const date = sanitizeDate(req.body.date);
    const time = sanitizeTime(req.body.time);
    const location = sanitizeString(req.body.location, 200);
    const location_url = sanitizeUrl(req.body.location_url);
    const spots = sanitizeNumber(req.body.spots, 1, 999);

    const result = await db.query(
      `UPDATE events SET name = $1, date = $2, time = $3, location = $4, location_url = $5, spots = $6
       WHERE id = $7 RETURNING *`,
      [name, date, time, location, location_url, spots, req.params.id]
    );
    await logAction('event', parseInt(req.params.id), 'updated', req.user, name);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/events/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    await logAction('event', parseInt(req.params.id), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NEWS ====================

router.get('/news', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        n.*,
        COUNT(DISTINCT unr.user_id) as read_count,
        (SELECT COUNT(*) FROM users WHERE is_approved = true) as total_users
      FROM news n
      LEFT JOIN user_news_read unr ON n.id = unr.news_id
      GROUP BY n.id
      ORDER BY n.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get news read details (who read specific news)
router.get('/news/:id/reads', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id, u.username, u.display_name, u.email,
        unr.read_at
      FROM user_news_read unr
      JOIN users u ON unr.user_id = u.id
      WHERE unr.news_id = $1
      ORDER BY unr.read_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news reads error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/news', async (req, res) => {
  try {
    const title = sanitizeString(req.body.title, 200);
    const message = sanitizeString(req.body.message, 2000);
    const type = sanitizeString(req.body.type, 30) || 'info';
    const emoji = sanitizeString(req.body.emoji, 10) || '📢';
    const event_details = req.body.event_details || null;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const publicId = await generatePublicId('news', 'NEWS');
    const result = await db.query(
      `INSERT INTO news (public_id, title, message, type, emoji, event_details) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [publicId, title, message, type, emoji, event_details]
    );
    await logAction('news', result.rows[0].id, 'created', req.user, title);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/news/:id', async (req, res) => {
  try {
    const title = sanitizeString(req.body.title, 200);
    const message = sanitizeString(req.body.message, 2000);
    const type = sanitizeString(req.body.type, 30);
    const emoji = sanitizeString(req.body.emoji, 10);
    const event_details = req.body.event_details;

    const result = await db.query(
      `UPDATE news SET title = $1, message = $2, type = $3, emoji = $4, event_details = $5
       WHERE id = $6 RETURNING *`,
      [title, message, type, emoji, event_details, req.params.id]
    );
    await logAction('news', parseInt(req.params.id), 'updated', req.user, title);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/news/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    await logAction('news', parseInt(req.params.id), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ARTICLES ====================

router.post('/articles', async (req, res) => {
  try {
    const category = sanitizeString(req.body.category, 50);
    const title = sanitizeString(req.body.title, 200);
    const description = sanitizeString(req.body.description, 500);
    const content = sanitizeString(req.body.content, 50000);
    const read_time = sanitizeString(req.body.read_time, 20) || '5 min';
    const image_url = sanitizeUrl(req.body.image_url);

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const publicId = await generatePublicId('articles', 'ART');
    let result;
    try {
      result = await db.query(
        `INSERT INTO articles (public_id, category, title, description, content, read_time, image_url, author_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [publicId, category, title, description, content, read_time, image_url || null, req.user.id]
      );
    } catch (colErr) {
      result = await db.query(
        `INSERT INTO articles (public_id, category, title, description, content, read_time, author_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [publicId, category, title, description, content, read_time, req.user.id]
      );
    }
    cache.invalidatePrefix('articles');
    await logAction('article', result.rows[0].id, 'created', req.user, title);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create article error:', error);
    res.status(500).json({ error: 'Create failed: ' + error.message });
  }
});

router.put('/articles/:id', async (req, res) => {
  try {
    const category = sanitizeString(req.body.category, 50);
    const title = sanitizeString(req.body.title, 200);
    const description = sanitizeString(req.body.description, 500);
    const content = sanitizeString(req.body.content, 50000);
    const read_time = sanitizeString(req.body.read_time, 20);
    const image_url = sanitizeUrl(req.body.image_url);

    let result;
    try {
      result = await db.query(
        `UPDATE articles SET category = $1, title = $2, description = $3, content = $4, read_time = $5, image_url = $6
         WHERE id = $7 RETURNING *`,
        [category, title, description, content, read_time, image_url || null, req.params.id]
      );
    } catch (colErr) {
      result = await db.query(
        `UPDATE articles SET category = $1, title = $2, description = $3, content = $4, read_time = $5
         WHERE id = $6 RETURNING *`,
        [category, title, description, content, read_time, req.params.id]
      );
    }
    cache.invalidatePrefix('articles');
    await logAction('article', parseInt(req.params.id), 'updated', req.user, title);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update article error:', error);
    res.status(500).json({ error: 'Update failed: ' + error.message });
  }
});

router.delete('/articles/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM favorites WHERE item_type = 'article' AND item_id = $1", [req.params.id]);
    await db.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    cache.invalidatePrefix('articles');
    await logAction('article', parseInt(req.params.id), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete article error:', error);
    res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
});

// ==================== PRODUCTS ====================

router.get('/products', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products ORDER BY category, name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 200);
    const description = sanitizeString(req.body.description, 2000);
    const price = sanitizeNumber(req.body.price, 0, 99999);
    const category = sanitizeString(req.body.category, 50);
    const image_url = sanitizeUrl(req.body.image_url);
    const stripe_price_id = sanitizeString(req.body.stripe_price_id, 100);
    const is_active = req.body.is_active !== false;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const publicId = await generatePublicId('products', 'PROD');
    const result = await db.query(
      `INSERT INTO products (public_id, name, description, price, category, image_url, stripe_price_id, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, description, price, category, image_url || null, stripe_price_id || null, is_active]
    );
    cache.invalidatePrefix('products');
    res.json(result.rows[0]);
    await logAction('product', result.rows[0].id, 'created', req.user, name);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 200);
    const description = sanitizeString(req.body.description, 2000);
    const price = sanitizeNumber(req.body.price, 0, 99999);
    const category = sanitizeString(req.body.category, 50);
    const image_url = sanitizeUrl(req.body.image_url);
    const stripe_price_id = sanitizeString(req.body.stripe_price_id, 100);
    const is_active = req.body.is_active;

    const result = await db.query(
      `UPDATE products SET name = $1, description = $2, price = $3, category = $4, 
       image_url = $5, stripe_price_id = $6, is_active = $7
       WHERE id = $8 RETURNING *`,
      [name, description, price, category, image_url, stripe_price_id, is_active, req.params.id]
    );
    cache.invalidatePrefix('products');
    res.json(result.rows[0]);
    await logAction('product', parseInt(req.params.id), 'updated', req.user, name);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    cache.invalidatePrefix('products');
    await logAction('product', parseInt(req.params.id), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ORDERS ====================

router.get('/orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const result = await db.query(`
      SELECT o.*, u.username, u.email
      FROM orders o JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending_payment', 'completed', 'pending_shipment', 'shipped', 'cancelled', 'refunded'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const result = await db.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json(result.rows[0]);
    await logAction('order', parseInt(req.params.id), 'status_' + status, req.user);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== RFID ====================

router.get('/rfid/all', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT rb.*, u.username, u.email
      FROM rfid_bands rb LEFT JOIN users u ON rb.user_id = u.id
      ORDER BY rb.assigned_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/rfid/user/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM rfid_bands WHERE user_id = $1 ORDER BY assigned_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/rfid/:bandId', async (req, res) => {
  try {
    await db.query('DELETE FROM rfid_bands WHERE id = $1', [req.params.bandId]);
    await logAction('rfid', parseInt(req.params.bandId), 'deleted', req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USER DETAILS ====================

// Get user's orders
router.get('/users/:id/orders', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_name, product_category, amount, 
             booking_date, booking_time, status, shipping_address, phone, created_at
      FROM orders 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's events
router.get('/users/:id/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.id, e.public_id, e.name, e.date, e.time, ea.registered_at
      FROM event_attendees ea
      JOIN events e ON ea.event_id = e.id
      WHERE ea.user_id = $1
      ORDER BY e.date DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's login history
router.get('/users/:id/logins', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, email, login_time, ip_address, user_agent, success
      FROM user_logins
      WHERE user_id = $1
      ORDER BY login_time DESC
      LIMIT 50
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user logins error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ACHIEVEMENTS ====================

// Get achievements statistics
router.get('/achievements/stats', async (req, res) => {
  try {
    const { ACHIEVEMENTS } = require('../achievements');
    
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
    
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      stats[id] = {
        ...def,
        tiers: { bronze: 0, silver: 0, gold: 0, platinum: 0, special: 0 }
      };
    }
    
    autoResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers[row.tier] = parseInt(row.count);
      }
    });
    
    manualResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers.special = parseInt(row.count);
      }
    });
    
    res.json(Object.values(stats));
  } catch (error) {
    console.error('Get achievements stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's manual achievements
router.get('/users/:id/manual-achievements', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT uma.*, u.username as awarded_by_name
      FROM user_manual_achievements uma
      LEFT JOIN users u ON uma.awarded_by = u.id
      WHERE uma.user_id = $1
      ORDER BY uma.awarded_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get manual achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/users/:id/grant-achievement', async (req, res) => {
  try {
    const achievement_id = parseInt(req.body.achievement_id);
    const note = sanitizeString(req.body.note, 500) || null;
    if (isNaN(achievement_id)) return res.status(400).json({ error: 'Invalid achievement ID' });
    await db.query(`
      INSERT INTO user_manual_achievements (user_id, achievement_id, awarded_by, note)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, achievement_id) DO NOTHING
    `, [req.params.id, achievement_id, req.user.id, note || null]);
    await logAction('achievement', achievement_id, 'granted', req.user, 'user_' + req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/users/:id/revoke-achievement/:achievementId', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_manual_achievements WHERE user_id = $1 AND achievement_id = $2',
      [req.params.id, req.params.achievementId]
    );
    await logAction('achievement', parseInt(req.params.achievementId), 'revoked', req.user, 'user_' + req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ALL COMMENTS ====================

// Get all comments (for admin panel)
router.get('/comments', async (req, res) => {
  try {
    // Get all trick comments
    const trickComments = await db.query(`
      SELECT 
        tc.id,
        'trick' as comment_type,
        tc.content,
        tc.created_at,
        tc.is_deleted,
        tc.deleted_at,
        tc.deleted_by,
        tc.trick_id,
        t.name as trick_name,
        tc.owner_id,
        owner.username as owner_username,
        tc.author_id,
        author.username as author_username
      FROM trick_comments tc
      JOIN tricks t ON tc.trick_id = t.id
      JOIN users owner ON tc.owner_id = owner.id
      JOIN users author ON tc.author_id = author.id
      ORDER BY tc.created_at DESC
      LIMIT 500
    `);
    
    // Get all achievement comments
    const achievementComments = await db.query(`
      SELECT 
        ac.id,
        'achievement' as comment_type,
        ac.content,
        ac.created_at,
        ac.is_deleted,
        ac.deleted_at,
        ac.deleted_by,
        ac.achievement_id,
        NULL as trick_name,
        ac.owner_id,
        owner.username as owner_username,
        ac.author_id,
        author.username as author_username
      FROM achievement_comments ac
      JOIN users owner ON ac.owner_id = owner.id
      JOIN users author ON ac.author_id = author.id
      ORDER BY ac.created_at DESC
      LIMIT 500
    `);
    
    // Combine and sort by date
    const allComments = [
      ...trickComments.rows,
      ...achievementComments.rows
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ comments: allComments });
  } catch (error) {
    console.error('Get all comments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USER DETAILS (Comments & Social) ====================

// Get user full details with stats
router.get('/users/:id/details', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get user basic info
    const userRes = await db.query(`
      SELECT id, public_id, email, username, display_name, avatar_base64,
             is_admin, is_coach, is_staff, is_club_member, is_approved, is_blocked,
             created_at, last_login
      FROM users WHERE id = $1
    `, [userId]);
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userRes.rows[0];
    
    // Get comments stats
    const commentsWrittenRes = await db.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE is_deleted = false OR is_deleted IS NULL) as active,
             COUNT(*) FILTER (WHERE is_deleted = true) as deleted
      FROM (
        SELECT is_deleted FROM trick_comments WHERE author_id = $1
        UNION ALL
        SELECT is_deleted FROM achievement_comments WHERE author_id = $1
      ) combined
    `, [userId]);
    
    const commentsReceivedRes = await db.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE is_deleted = false OR is_deleted IS NULL) as active,
             COUNT(*) FILTER (WHERE is_deleted = true) as deleted
      FROM (
        SELECT is_deleted FROM trick_comments WHERE owner_id = $1 AND author_id != $1
        UNION ALL
        SELECT is_deleted FROM achievement_comments WHERE owner_id = $1 AND author_id != $1
      ) combined
    `, [userId]);
    
    // Get following count (users this person follows)
    const followingRes = await db.query(`
      SELECT COUNT(*) as count FROM favorites 
      WHERE user_id = $1 AND item_type = 'user'
    `, [userId]);
    
    // Get followers count (users who follow this person)
    const followersRes = await db.query(`
      SELECT COUNT(*) as count FROM favorites 
      WHERE item_type = 'user' AND item_id = $1
    `, [userId]);
    
    res.json({
      user,
      stats: {
        commentsWritten: commentsWrittenRes.rows[0],
        commentsReceived: commentsReceivedRes.rows[0],
        following: parseInt(followingRes.rows[0].count),
        followers: parseInt(followersRes.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get comments written by user
router.get('/users/:id/comments/written', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get trick comments written by user
    const trickComments = await db.query(`
      SELECT 
        tc.id,
        'trick' as comment_type,
        tc.content,
        tc.created_at,
        tc.is_deleted,
        tc.deleted_at,
        tc.deleted_by,
        tc.trick_id,
        t.name as trick_name,
        tc.owner_id as target_user_id,
        u.username as target_username,
        u.display_name as target_display_name,
        deleter.username as deleted_by_username
      FROM trick_comments tc
      JOIN tricks t ON tc.trick_id = t.id
      JOIN users u ON tc.owner_id = u.id
      LEFT JOIN users deleter ON tc.deleted_by = deleter.id
      WHERE tc.author_id = $1
      ORDER BY tc.created_at DESC
    `, [userId]);
    
    // Get achievement comments written by user
    const achievementComments = await db.query(`
      SELECT 
        ac.id,
        'achievement' as comment_type,
        ac.content,
        ac.created_at,
        ac.is_deleted,
        ac.deleted_at,
        ac.deleted_by,
        ac.achievement_id,
        ac.owner_id as target_user_id,
        u.username as target_username,
        u.display_name as target_display_name,
        deleter.username as deleted_by_username
      FROM achievement_comments ac
      JOIN users u ON ac.owner_id = u.id
      LEFT JOIN users deleter ON ac.deleted_by = deleter.id
      WHERE ac.author_id = $1
      ORDER BY ac.created_at DESC
    `, [userId]);
    
    // Combine and sort
    const allComments = [
      ...trickComments.rows,
      ...achievementComments.rows
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ comments: allComments });
  } catch (error) {
    console.error('Get written comments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get comments received by user (on their tricks/achievements)
router.get('/users/:id/comments/received', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get trick comments on user's tricks
    const trickComments = await db.query(`
      SELECT 
        tc.id,
        'trick' as comment_type,
        tc.content,
        tc.created_at,
        tc.is_deleted,
        tc.deleted_at,
        tc.deleted_by,
        tc.trick_id,
        t.name as trick_name,
        tc.author_id as from_user_id,
        author.username as from_username,
        author.display_name as from_display_name,
        deleter.username as deleted_by_username
      FROM trick_comments tc
      JOIN tricks t ON tc.trick_id = t.id
      JOIN users author ON tc.author_id = author.id
      LEFT JOIN users deleter ON tc.deleted_by = deleter.id
      WHERE tc.owner_id = $1 AND tc.author_id != $1
      ORDER BY tc.created_at DESC
    `, [userId]);
    
    // Get achievement comments on user's achievements
    const achievementComments = await db.query(`
      SELECT 
        ac.id,
        'achievement' as comment_type,
        ac.content,
        ac.created_at,
        ac.is_deleted,
        ac.deleted_at,
        ac.deleted_by,
        ac.achievement_id,
        ac.author_id as from_user_id,
        author.username as from_username,
        author.display_name as from_display_name,
        deleter.username as deleted_by_username
      FROM achievement_comments ac
      JOIN users author ON ac.author_id = author.id
      LEFT JOIN users deleter ON ac.deleted_by = deleter.id
      WHERE ac.owner_id = $1 AND ac.author_id != $1
      ORDER BY ac.created_at DESC
    `, [userId]);
    
    // Combine and sort
    const allComments = [
      ...trickComments.rows,
      ...achievementComments.rows
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ comments: allComments });
  } catch (error) {
    console.error('Get received comments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Soft delete trick comment (admin)
router.delete('/comments/trick/:id', async (req, res) => {
  try {
    const commentId = req.params.id;
    
    const result = await db.query(`
      UPDATE trick_comments 
      SET is_deleted = true, deleted_at = NOW(), deleted_by = $1
      WHERE id = $2
      RETURNING id
    `, [req.user.id, commentId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    await logAction('comment_trick', parseInt(commentId), 'deleted', req.user);
    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete trick comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Soft delete achievement comment (admin)
router.delete('/comments/achievement/:id', async (req, res) => {
  try {
    const commentId = req.params.id;
    
    const result = await db.query(`
      UPDATE achievement_comments 
      SET is_deleted = true, deleted_at = NOW(), deleted_by = $1
      WHERE id = $2
      RETURNING id
    `, [req.user.id, commentId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    await logAction('comment_achievement', parseInt(commentId), 'deleted', req.user);
    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete achievement comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Restore trick comment (admin)
router.post('/comments/trick/:id/restore', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE trick_comments 
      SET is_deleted = false, deleted_at = NULL, deleted_by = NULL
      WHERE id = $1
      RETURNING id
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    await logAction('comment_trick', parseInt(req.params.id), 'restored', req.user);
    res.json({ success: true, message: 'Comment restored' });
  } catch (error) {
    console.error('Restore trick comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Restore achievement comment (admin)
router.post('/comments/achievement/:id/restore', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE achievement_comments 
      SET is_deleted = false, deleted_at = NULL, deleted_by = NULL
      WHERE id = $1
      RETURNING id
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    await logAction('comment_achievement', parseInt(req.params.id), 'restored', req.user);
    res.json({ success: true, message: 'Comment restored' });
  } catch (error) {
    console.error('Restore achievement comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user social (following & followers)
router.get('/users/:id/social', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get users this person follows
    const followingRes = await db.query(`
      SELECT 
        f.id as favorite_id,
        f.created_at as since,
        u.id, u.username, u.display_name, u.avatar_base64,
        u.is_admin, u.is_coach, u.is_staff, u.is_club_member
      FROM favorites f
      JOIN users u ON f.item_id = u.id
      WHERE f.user_id = $1 AND f.item_type = 'user'
      ORDER BY f.created_at DESC
    `, [userId]);
    
    // Get users who follow this person
    const followersRes = await db.query(`
      SELECT 
        f.id as favorite_id,
        f.created_at as since,
        u.id, u.username, u.display_name, u.avatar_base64,
        u.is_admin, u.is_coach, u.is_staff, u.is_club_member
      FROM favorites f
      JOIN users u ON f.user_id = u.id
      WHERE f.item_id = $1 AND f.item_type = 'user'
      ORDER BY f.created_at DESC
    `, [userId]);
    
    res.json({
      following: followingRes.rows,
      followers: followersRes.rows
    });
  } catch (error) {
    console.error('Get user social error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== AUDIT HISTORY ====================

// Get history for any entity
router.get('/audit/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const validTypes = ['trick', 'article', 'event', 'news', 'user'];
    if (!validTypes.includes(entityType)) {
      return res.status(400).json({ error: 'Invalid entity type' });
    }
    const history = await getHistory(entityType, parseInt(entityId));
    res.json(history);
  } catch (error) {
    console.error('Get audit history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
