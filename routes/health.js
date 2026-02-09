// Health & Verify Routes - /api/health, /api/verify
const express = require('express');
const router = express.Router();
const db = require('../database');
const config = require('../config');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Verify ticket by code
router.get('/verify/:code', async (req, res) => {
  try {
    const { code } = req.params;

    // Basic input validation
    if (!code || code.length < 3 || code.length > 20) {
      return res.status(400).json({ valid: false, error: 'Invalid code format' });
    }
    
    const result = await db.query(`
      SELECT o.public_id, o.product_name, o.product_category, o.amount, 
             o.booking_date, o.booking_time, o.status, o.created_at,
             u.username, u.display_name, u.avatar_base64
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE UPPER(SUBSTRING(o.public_id FROM POSITION('-' IN o.public_id) + 1)) = UPPER($1)
        AND o.status IN ('completed', 'pending_shipment')
    `, [code]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        valid: false, 
        error: 'Ticket not found or not valid' 
      });
    }
    
    const order = result.rows[0];
    res.json({
      valid: true,
      ticket: {
        code: code.toUpperCase(),
        product: order.product_name,
        category: order.product_category,
        booking_date: order.booking_date,
        booking_time: order.booking_time,
        status: order.status,
        user: {
          username: order.username,
          display_name: order.display_name,
          avatar: order.avatar_base64
        }
      }
    });
  } catch (error) {
    console.error('Verify ticket error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostic: Check roles — requires admin auth (no hardcoded key)
router.get('/check-roles', authMiddleware, adminMiddleware, async (req, res) => {
  const results = { columns: {}, users: [], sample: null };

  try {
    const columnsCheck = await db.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('is_coach', 'is_staff', 'is_club_member')
    `);
    results.columns = columnsCheck.rows;

    try {
      const usersCheck = await db.query(`
        SELECT id, username, is_coach, is_staff, is_club_member 
        FROM users 
        WHERE is_coach = true OR is_staff = true OR is_club_member = true
      `);
      results.users = usersCheck.rows;
    } catch (e) {
      results.usersError = e.message;
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
