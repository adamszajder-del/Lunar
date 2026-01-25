// ============================================================================
// ADD THIS ENDPOINT TO server.js - after /api/users/me/avatar endpoint
// ============================================================================

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
