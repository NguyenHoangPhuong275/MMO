const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const cacheService = require('../services/cacheService');
const payosService = require('../services/payosService');
const msbService = require('../services/msbService');
const msbPaymentReconciler = require('../services/msbPaymentReconciler');
const upstreamService = require('../services/upstreamService');
const { buildVietQrUrl } = require('../services/vietQrService');
const { safeString, safeInt } = require('../middleware/security');

function serializeCheckout(checkout, order = null) {
  const publicErrors = {
    amount_mismatch: 'Số tiền chuyển khoản không đúng với giá trị đơn. Vui lòng liên hệ quản trị viên.',
    paid_late: 'Thanh toán được ghi nhận sau khi đơn hết hạn. Vui lòng liên hệ quản trị viên.',
    paid_pending_delivery: 'Tiền đã được ghi nhận nhưng kho chưa giao được sản phẩm. Quản trị viên sẽ xử lý đơn này.',
    expired: 'Đơn đã hết hạn trước khi nhận được thanh toán.'
  };

  let parsedItems = [];
  if (order?.items) {
    try {
      parsedItems = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    } catch (e) {
      parsedItems = [];
    }
  }

  return {
    code: checkout.code,
    order_code: checkout.order_code || null,
    product_name: checkout.product_name,
    quantity: checkout.quantity,
    amount_vnd: checkout.amount_vnd,
    status: checkout.status,
    qr_url: checkout.qr_url,
    checkout_url: checkout.checkout_url || null,
    bank_account_number: checkout.bank_account_number || msbService.accountNumber,
    bank_account_name: checkout.bank_account_name || msbService.accountName,
    bank_name: checkout.bank_name || (checkout.payment_provider === 'payos' ? 'VietQR (PayOS)' : 'MSB'),
    transfer_content: checkout.payment_provider === 'payos' ? (checkout.code || `DH${checkout.order_code}`) : checkout.code,
    expires_at: checkout.expires_at,
    error: publicErrors[checkout.status] || checkout.error || null,
    order_id: order?.id || checkout.order_id || null,
    items: parsedItems
  };
}

async function deliverPayosPaidCheckout(checkout) {
  try {
    const upstreamData = await upstreamService.buyProduct(checkout.product_id, checkout.quantity, 'vnd');
    db.completePayosCheckout(
      checkout.id,
      upstreamData.items || [],
      upstreamData.order_id || null
    );
    cacheService.refreshProducts().catch(() => {});
    return true;
  } catch (error) {
    db.markPayosCheckoutDeliveryFailed(checkout.id, error.message);
    console.error(`PayOS checkout ${checkout.code} đã nhận tiền nhưng chưa giao được: ${error.message}`);
    return false;
  }
}

function createShopRoutes({ requireAuth, purchaseLimiter, checkoutLimiter }) {
  const router = express.Router();

  // GET /api/shop/products
  router.get('/products', async (req, res, next) => {
    try {
      const force = req.query.refresh === 'true';
      const catalog = await cacheService.getCatalog(force);
      return res.json({
        success: true,
        products: catalog.products.map(product => ({
          id: product.id,
          name: product.name,
          description: product.description,
          stock: product.stock,
          category: product.category,
          price_vnd: product.price_vnd
        })),
        updated_at: catalog.updated_at
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/shop/info
  router.get('/info', (req, res) => {
    const isVietQrEnabled = payosService.isConfigured() || msbService.isConfigured();
    return res.json({
      success: true,
      site_title: db.getSetting('site_title') || 'Shop Bot MMO',
      announcement: db.getSetting('site_announcement') || '',
      msb_payment_enabled: isVietQrEnabled,
      vietqr_payment_enabled: isVietQrEnabled,
      payos_payment_enabled: payosService.isConfigured()
    });
  });

  // POST /api/shop/checkout/vietqr & /api/shop/checkout/msb
  router.post(['/checkout/vietqr', '/checkout/msb'], requireAuth, purchaseLimiter, checkoutLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const productId = safeInt(req.body.product_id, 0);
    const numQty = safeInt(req.body.quantity, 0, 1, 100);
    const idempotencyKey = safeString(req.get('idempotency-key') || req.body.idempotency_key || crypto.randomUUID(), 128);

    if (!productId || !numQty || numQty < 1 || numQty > 100) {
      return res.status(400).json({ success: false, error: 'Vui lòng chọn sản phẩm và số lượng hợp lệ' });
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ success: false, error: 'Mã chống trùng giao dịch không hợp lệ' });
    }

    const isPayosConfigured = payosService.isConfigured();
    const isMsbConfigured = msbService.isConfigured();

    if (!isPayosConfigured && !isMsbConfigured) {
      return res.status(503).json({ success: false, error: 'Cổng thanh toán VietQR đang được bảo trì. Vui lòng quay lại sau.' });
    }

    try {
      const catalog = await cacheService.getCatalog();
      const product = catalog.products.find(p => p.id === Number(productId));
      if (!product) {
        return res.status(404).json({ success: false, error: 'Sản phẩm không tồn tại hoặc đã ngừng kinh doanh' });
      }

      if (product.stock < numQty) {
        return res.status(400).json({ success: false, error: `Sản phẩm hiện chỉ còn ${product.stock} tài khoản` });
      }

      const amountVnd = Math.round(Number(product.price_vnd) * numQty);
      const costPriceVnd = Math.round(Number(product.cost_price_vnd) * numQty);
      if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0 || !Number.isSafeInteger(costPriceVnd) || costPriceVnd < 0) {
        throw new Error('Giá sản phẩm không hợp lệ');
      }

      // 1. PayOS Gateway
      if (isPayosConfigured) {
        const numericOrderCode = Number(String(Date.now()).slice(-7) + Math.floor(Math.random() * 90 + 10));
        const code = `DH${numericOrderCode}`;
        const returnUrl = `${req.protocol}://${req.get('host')}/?modal=payment`;
        const cancelUrl = returnUrl;

        const payosRes = await payosService.createPaymentLink({
          orderCode: numericOrderCode,
          amount: amountVnd,
          description: `DH${numericOrderCode}`,
          items: [
            {
              name: String(product.name || 'Tai khoan').slice(0, 50),
              quantity: numQty,
              price: Math.round(Number(product.price_vnd))
            }
          ],
          returnUrl,
          cancelUrl
        });

        const qrUrl = payosRes.qrCode
          ? `https://img.vietqr.io/image/${payosRes.bin || '970422'}-${payosRes.accountNumber}-compact2.png?amount=${amountVnd}&addInfo=${encodeURIComponent(`DH${numericOrderCode}`)}&accountName=${encodeURIComponent(payosRes.accountName || '')}`
          : payosRes.checkoutUrl;

        const result = db.createPayosCheckout({
          idempotencyKey,
          orderCode: numericOrderCode,
          code,
          userId: req.user.id,
          product,
          quantity: numQty,
          amountVnd,
          costPriceVnd,
          qrUrl,
          paymentLinkId: payosRes.paymentLinkId || null,
          checkoutUrl: payosRes.checkoutUrl || null,
          bankAccountNumber: payosRes.accountNumber || null,
          bankAccountName: payosRes.accountName || null,
          bankName: payosRes.bin || 'VietQR',
          ttlMinutes: 15
        });

        return res.status(result.replay ? 200 : 201).json({
          success: true,
          replayed: result.replay,
          checkout: serializeCheckout(result.checkout)
        });
      }

      // 2. Fallback MSB
      const code = `P${String(product.name || 'X').slice(0, 4).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const qrUrl = buildVietQrUrl({
        bankBin: msbService.bankBin,
        accountNumber: msbService.accountNumber,
        accountName: msbService.accountName,
        amountVnd,
        memo: code
      });
      const ttlMinutes = Math.min(Math.max(Number(process.env.ORDER_TTL_MINUTES) || 30, 5), 60);
      const result = db.createMsbCheckout({
        idempotencyKey,
        code,
        userId: req.user.id,
        product,
        quantity: numQty,
        amountVnd,
        costPriceVnd,
        qrUrl,
        ttlMinutes
      });

      return res.status(result.replay ? 200 : 201).json({
        success: true,
        replayed: result.replay,
        checkout: serializeCheckout(result.checkout)
      });
    } catch (err) {
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ success: false, error: 'Không thể tạo mã đơn duy nhất. Vui lòng thử lại.' });
      }
      next(err);
    }
  });

  // GET /api/shop/checkout/vietqr/status & /api/shop/checkout/msb/status
  router.get(['/checkout/vietqr/status', '/checkout/msb/status'], requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const code = safeString(req.query.code, 40).toUpperCase();
    if (!code) {
      return res.status(400).json({ success: false, error: 'Mã đơn thanh toán không hợp lệ' });
    }

    try {
      db.expirePendingMsbCheckouts();
      const checkout = db.getPayosCheckoutByCode(req.user.id, code) || db.getMsbCheckoutByCode(req.user.id, code);
      if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });

      // Direct PayOS reconciliation if pending
      if (checkout.payment_provider === 'payos' && checkout.status === 'pending' && checkout.order_code) {
        try {
          const payosInfo = await payosService.getPaymentLinkInformation(checkout.order_code);
          if (payosInfo && payosInfo.status === 'PAID') {
            const claim = db.claimPayosPaymentEvent({
              orderCode: checkout.order_code,
              transactionId: `PAYOS_POLL_${checkout.order_code}_${Date.now()}`,
              amountVnd: payosInfo.amountPaid || checkout.amount_vnd,
              description: `PayOS Polling Check ${checkout.order_code}`,
              rawPayload: payosInfo
            });
            if (claim.status === 'claimed' && claim.checkout) {
              await deliverPayosPaidCheckout(claim.checkout);
            }
          }
        } catch (checkErr) {
          console.warn(`PayOS status poll warning:`, checkErr.message);
        }
      }

      const refreshed = db.getPayosCheckoutByCode(req.user.id, code) || db.getMsbCheckoutByCode(req.user.id, code) || checkout;
      const order = refreshed.order_id ? db.getOrderById(refreshed.order_id, req.user.id) : null;
      return res.json({ success: true, checkout: serializeCheckout(refreshed, order) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/shop/checkout/vietqr/check & /api/shop/checkout/msb/check
  router.post(['/checkout/vietqr/check', '/checkout/msb/check'], requireAuth, purchaseLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const code = safeString(req.body.code, 40).toUpperCase();
    if (!code) {
      return res.status(400).json({ success: false, error: 'Thiếu mã đơn thanh toán' });
    }

    try {
      const checkout = db.getPayosCheckoutByCode(req.user.id, code) || db.getMsbCheckoutByCode(req.user.id, code);
      if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });

      if (checkout.payment_provider === 'payos' && checkout.order_code) {
        try {
          const payosInfo = await payosService.getPaymentLinkInformation(checkout.order_code);
          if (payosInfo && payosInfo.status === 'PAID') {
            const claim = db.claimPayosPaymentEvent({
              orderCode: checkout.order_code,
              transactionId: `PAYOS_MANUAL_${checkout.order_code}_${Date.now()}`,
              amountVnd: payosInfo.amountPaid || checkout.amount_vnd,
              description: `PayOS Manual Check ${checkout.order_code}`,
              rawPayload: payosInfo
            });
            if (claim.status === 'claimed' && claim.checkout) {
              await deliverPayosPaidCheckout(claim.checkout);
            }
          }
        } catch (checkErr) {
          console.warn(`PayOS manual check warning:`, checkErr.message);
        }
      } else if (checkout.payment_provider === 'msb') {
        await msbPaymentReconciler.checkNow({ allowLogin: true });
      }

      const refreshed = db.getPayosCheckoutByCode(req.user.id, code) || db.getMsbCheckoutByCode(req.user.id, code) || checkout;
      const order = refreshed.order_id ? db.getOrderById(refreshed.order_id, req.user.id) : null;
      return res.json({ success: true, checkout: serializeCheckout(refreshed, order) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/shop/checkout/cancel
  router.post('/checkout/cancel', requireAuth, async (req, res, next) => {
    try {
      const code = safeString(req.body.code, 40).toUpperCase();
      if (!code) return res.status(400).json({ success: false, error: 'Thiếu mã đơn thanh toán' });

      const result = db.cancelCheckout(req.user.id, code);
      if (!result.success) {
        return res.status(404).json({ success: false, error: result.error });
      }

      if (result.payment_provider === 'payos' && result.order_code) {
        try {
          await payosService.cancelPaymentLink(result.order_code, 'Khách hàng hủy đơn');
        } catch (cancelErr) {
          console.warn(`PayOS cancel link warning for ${result.order_code}:`, cancelErr.message);
        }
      }

      return res.json({ success: true, message: 'Đơn thanh toán đã được hủy thành công' });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/shop/orders
  router.get('/orders', requireAuth, (req, res, next) => {
    try {
      const orders = db.getUserOrders(req.user.id);
      return res.json({ success: true, orders });
    } catch (err) {
      next(err);
    }
  });

  return { router, deliverPayosPaidCheckout, serializeCheckout };
}

module.exports = createShopRoutes;
