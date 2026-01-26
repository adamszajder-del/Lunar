// Orders Routes - /api/orders/*
const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { generatePublicId } = require('../utils/publicId');

const stripe = require('stripe')(config.STRIPE_SECRET_KEY);

// Verify payment and complete order
router.post('/verify-payment', authMiddleware, async (req, res) => {
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
        
        // Create purchase notification (not news - news is for admin announcements)
        try {
          const bookingInfo = order.booking_date 
            ? ` See you on ${new Date(order.booking_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${order.booking_time ? ` at ${order.booking_time}` : ''}!`
            : '';
          
          await db.query(
            `INSERT INTO notifications (user_id, type, target_type, target_id, target_name, message)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [req.user.id, 'purchase', 'order', order.id, order.product_name, 
             `Thanks for purchasing ${order.product_name}!${bookingInfo}`]
          );
          
          // Also create notification group
          await db.query(
            `INSERT INTO notification_groups (user_id, type, target_type, target_id, last_actor_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [req.user.id, 'purchase', 'order', order.id, req.user.id]
          );
        } catch (notifErr) {
          console.error('Error creating purchase notification:', notifErr);
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

// Get user's orders
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_id, product_name, product_category, 
             amount, booking_date, booking_time, status, created_at,
             UPPER(SUBSTRING(public_id FROM POSITION('-' IN public_id) + 1)) as confirmation_code
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

// Get user's booked dates
router.get('/my-bookings', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_name, product_category, booking_date, booking_time, status, amount, created_at,
             UPPER(SUBSTRING(public_id FROM POSITION('-' IN public_id) + 1)) as confirmation_code
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

module.exports = router;
