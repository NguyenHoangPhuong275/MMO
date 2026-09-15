const express = require('express');
const db = require('../database');
const cacheService = require('../services/cacheService');
const mongoService = require('../services/mongoService');
const { safeString, safeInt } = require('../middleware/security');

function createAdminRoutes({ requireAdmin, deliverPayosPaidCheckout }) {
  const router = express.Router();

  // Apply admin authorization to all sub-routes
  router.use(requireAdmin);

  // GET /api/admin/stats
  router.get('/stats', async (req, res, next) => {
    try {
      const stats = db.getAdminStats();
      const supplierBalance = await cacheService.getSupplierBalance(true);

      return res.json({
        success: true,
        stats,
        supplier_balance: supplierBalance,
        mongodb_connected: mongoService.isConnected
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings
  router.get('/settings', (req, res) => {
    const settings = db.getAllSettings();
    return res.json({
      success: true,
      settings: {
        markup_percent: settings.markup_percent,
        site_title: settings.site_title,
        site_announcement: settings.site_announcement
      }
    });
  });

  // POST /api/admin/settings
  router.post('/settings', (req, res, next) => {
    try {
      const { markup_percent, site_title, site_announcement } = req.body;

      if (markup_percent !== undefined) {
        const numMarkup = safeInt(markup_percent, 15, 0, 500);
        db.setSetting('markup_percent', numMarkup);
      }
      if (site_title !== undefined) {
        db.setSetting('site_title', safeString(site_title, 100));
      }
      if (site_announcement !== undefined) {
        db.setSetting('site_announcement', safeString(site_announcement, 255));
      }

      cacheService.invalidate();
      return res.json({ success: true, message: 'Đã lưu cấu hình cửa hàng thành công!' });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users
  router.get('/users', (req, res, next) => {
    try {
      const users = db.db.prepare('SELECT id, username, email, balance_vnd, role, created_at FROM users ORDER BY id DESC').all();
      return res.json({ success: true, users });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/users/balance
  router.post('/users/balance', (req, res, next) => {
    try {
      const userId = safeInt(req.body.user_id, 0);
      const deltaVnd = parseFloat(req.body.delta_vnd) || 0;
      const note = safeString(req.body.note, 150) || 'Admin điều chỉnh số dư';

      if (!userId) return res.status(400).json({ success: false, error: 'Thiếu user_id hợp lệ' });

      const result = db.adjustUserBalance(userId, deltaVnd, 0, note, 'admin_adjust');
      return res.json({ success: true, message: 'Điều chỉnh số dư thành công', ...result });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/orders
  router.get('/orders', (req, res, next) => {
    try {
      const limit = safeInt(req.query.limit, 100, 1, 500);
      const orders = db.getAllOrders(limit);
      return res.json({ success: true, orders });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/orders/retry-delivery
  router.post('/orders/retry-delivery', async (req, res, next) => {
    try {
      const checkoutId = safeInt(req.body.checkout_id, 0);
      if (!checkoutId) return res.status(400).json({ success: false, error: 'Thiếu checkout_id hợp lệ' });

      const checkout = db.db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkoutId);
      if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });
      if (checkout.status === 'delivered') return res.json({ success: true, message: 'Đơn này đã được giao thành công.' });

      const ok = await deliverPayosPaidCheckout(checkout);
      if (ok) {
        return res.json({ success: true, message: 'Đã tự động lấy hàng từ kho và giao thành công cho khách!' });
      } else {
        const refreshed = db.db.prepare('SELECT error FROM direct_checkouts WHERE id = ?').get(checkoutId);
        return res.status(400).json({ success: false, error: refreshed?.error || 'Giao hàng từ kho thất bại' });
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/orders/manual-deliver
  router.post('/orders/manual-deliver', (req, res, next) => {
    try {
      const checkoutId = safeInt(req.body.checkout_id, 0);
      const items = req.body.items;
      if (!checkoutId || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'Vui lòng cung cấp danh sách tài khoản hợp lệ' });
      }

      const checkout = db.db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkoutId);
      if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });

      const cleanItems = items.map(it => safeString(it, 1000)).filter(Boolean);
      if (checkout.payment_provider === 'payos') {
        db.completePayosCheckout(checkout.id, cleanItems, 'MANUAL_DELIVERY');
      } else {
        db.completeMsbCheckout(checkout.id, cleanItems, 'MANUAL_DELIVERY');
      }

      return res.json({ success: true, message: 'Đã cấp tài khoản thủ công cho khách thành công!' });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/mongo/sync
  router.post('/mongo/sync', async (req, res, next) => {
    try {
      const syncResult = await mongoService.syncAllFromSqlite(db.db);
      return res.json(syncResult);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createAdminRoutes;
