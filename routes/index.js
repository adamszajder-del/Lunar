// Routes Aggregator
const express = require('express');
const router = express.Router();

// Import all route modules
const authRoutes = require('./auth');
const usersRoutes = require('./users');
const tricksRoutes = require('./tricks');
const eventsRoutes = require('./events');
const newsRoutes = require('./news');
const articlesRoutes = require('./articles');
const productsRoutes = require('./products');
const cartRoutes = require('./cart');
const ordersRoutes = require('./orders');
const stripeRoutes = require('./stripe');
const rfidRoutes = require('./rfid');
const achievementsRoutes = require('./achievements');
const healthRoutes = require('./health');
const adminRoutes = require('./admin');
const migrationsRoutes = require('./migrations');

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/tricks', tricksRoutes);
router.use('/events', eventsRoutes);
router.use('/news', newsRoutes);
router.use('/articles', articlesRoutes);
router.use('/products', productsRoutes);
router.use('/cart', cartRoutes);
router.use('/orders', ordersRoutes);
router.use('/stripe', stripeRoutes);
router.use('/rfid', rfidRoutes);
router.use('/achievements', achievementsRoutes);
router.use('/', healthRoutes); // /api/health, /api/verify/:code
router.use('/admin', adminRoutes);
router.use('/', migrationsRoutes); // /api/run-*-migration

module.exports = router;
