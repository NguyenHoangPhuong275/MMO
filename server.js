require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const db = require('./database');
const upstreamService = require('./services/upstreamService');
const cacheService = require('./services/cacheService');
const msbService = require('./services/msbService');
const msbPaymentReconciler = require('./services/msbPaymentReconciler');
const payosService = require('./services/payosService');
const { buildVietQrUrl } = require('./services/vietQrService');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
let JWT_SECRET = process.env.JWT_SECRET || db.getSetting('jwt_secret');
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 0;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);

if (!process.env.JWT_SECRET && JWT_SECRET === 'mmo_super_secure_jwt_secret_key_2026_x789') {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  db.setSetting('jwt_secret', JWT_SECRET);
  console.warn('⚠️ Legacy JWT secret was rotated. Existing sessions must sign in again.');
}

// Trust reverse proxy for accurate client IP
if (TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS);

// Middleware
app.disable('x-powered-by');
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
if (allowedOrigins.length > 0) {
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin không được phép'));
    }
  }));
}
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  }
}));

// Rate limiters for scale & DDoS protection
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 reqs/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Quá nhiều yêu cầu, vui lòng thử lại sau giây lát.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 30, // 30 login/register attempts per 15 min
  message: { success: false, error: 'Bạn đã thử đăng nhập/đăng ký quá nhiều lần. Vui lòng thử lại sau 15 phút.' }
});

const purchaseLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40,
  message: { success: false, error: 'Thao tác mua quá nhanh. Vui lòng chờ vài giây.' }
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Bạn đã tạo quá nhiều đơn thanh toán. Vui lòng thử lại sau.' }
});

app.use('/api/', generalLimiter);

// JWT Auth Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(decoded.userId);
    req.user = user || null;
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Vui lòng đăng nhập để thực hiện chức năng này.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Quyền truy cập bị từ chối. Chỉ dành cho Quản trị viên.' });
  }
  next();
}

app.use(authMiddleware);

// ==========================================
// 1. AUTHENTICATION (REGISTER / LOGIN / ME)
// ==========================================
app.post('/api/auth/register', authLimiter, (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || username.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Tên tài khoản phải từ 3 ký tự trở lên.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Mật khẩu phải từ 6 ký tự trở lên.' });
    }

    const cleanUsername = username.trim();
    const existing = db.getUserByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Tên tài khoản này đã được sử dụng.' });
    }

    const user = db.createUser(cleanUsername, email ? email.trim() : null, password);
    const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tên tài khoản và mật khẩu.' });
    }

    const user = db.getUserByUsername(username.trim());
    if (!user || !db.verifyPassword(password, user.password_hash)) {
      return res.status(400).json({ success: false, error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
      created_at: req.user.created_at
    }
  });
});

// ==========================================
// 2. STOREFRONT PRODUCTS
// ==========================================
app.get('/api/shop/products', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const catalog = await cacheService.getCatalog(force);
    res.json({
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
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/shop/info', (req, res) => {
  const isVietQrEnabled = payosService.isConfigured() || msbService.isConfigured();
  res.json({
    success: true,
    site_title: db.getSetting('site_title') || 'Shop Bot MMO',
    announcement: db.getSetting('site_announcement') || '',
    msb_payment_enabled: isVietQrEnabled,
    vietqr_payment_enabled: isVietQrEnabled,
    payos_payment_enabled: payosService.isConfigured()
  });
});

// ==========================================
// 3. DIRECT VIETQR / PAYOS CHECKOUT
// ==========================================
function generateOrderCode(productName) {
  const asciiName = String(productName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  const abbreviation = asciiName
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 4) || 'X';
  return `P${abbreviation}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

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

app.post(['/api/shop/checkout/vietqr', '/api/shop/checkout/msb'], requireAuth, purchaseLimiter, checkoutLimiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { product_id, quantity } = req.body;
  const numQty = parseInt(quantity, 10);
  const idempotencyKey = String(req.get('idempotency-key') || req.body.idempotency_key || crypto.randomUUID()).trim();

  if (!product_id || !numQty || numQty < 1 || numQty > 100) {
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
    const product = catalog.products.find(p => p.id === Number(product_id));
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

    // 1. NẾU SỬ DỤNG PAYOS
    if (isPayosConfigured) {
      // PayOS orderCode phải là số nguyên (tối đa 9007199254740991)
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

      // Tạo QR Image VietQR chuẩn từ thông tin PayOS trả về
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

    // 2. FALLBACK NẾU SỬ DỤNG MSB TRỰC TIẾP
    const code = generateOrderCode(product.name);
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
    console.error(`[${req.requestId}] Create VietQR checkout failed:`, err.message);
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ success: false, error: 'Không thể tạo mã đơn duy nhất. Vui lòng thử lại.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// PayOS Webhook Endpoint
app.post(['/api/payments/payos/webhook', '/api/payment/payos/webhook'], async (req, res) => {
  try {
    const webhookData = await payosService.verifyWebhookData(req.body);
    console.log(`✅ [PayOS Webhook] Received & verified webhook for orderCode: ${webhookData.orderCode}`);

    if (webhookData && (webhookData.code === '00' || req.body.code === '00' || webhookData.desc === 'success')) {
      const { orderCode, amount, reference, transactionDateTime, description } = webhookData;

      const claim = db.claimPayosPaymentEvent({
        orderCode: Number(orderCode),
        transactionId: reference || `PAYOS_${orderCode}_${Date.now()}`,
        amountVnd: Number(amount),
        description: description || `PayOS Order ${orderCode}`,
        rawPayload: req.body
      });

      if (claim.status === 'claimed' && claim.checkout) {
        await deliverPayosPaidCheckout(claim.checkout);
      }
    }

    return res.json({ success: true, message: 'Webhook processed' });
  } catch (err) {
    console.error('PayOS Webhook error:', err.message);
    // Vẫn trả về 200/400 chuẩn cho PayOS
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.get(['/api/shop/checkout/vietqr/status', '/api/shop/checkout/msb/status'], requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ success: false, error: 'Mã đơn thanh toán không hợp lệ' });
  }

  db.expirePendingMsbCheckouts();
  const checkout = db.getPayosCheckoutByCode(req.user.id, code) || db.getMsbCheckoutByCode(req.user.id, code);
  if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });

  // Nếu là đơn PayOS đang pending, gọi API PayOS kiểm tra đối soát trực tiếp phòng khi webhook trễ
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
});

app.post(['/api/shop/checkout/vietqr/check', '/api/shop/checkout/msb/check'], requireAuth, purchaseLimiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.body.code || '').trim().toUpperCase();
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
});

// Cancel a pending checkout
app.post('/api/shop/checkout/cancel', requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, error: 'Thiếu mã đơn thanh toán' });

    const result = db.cancelCheckout(req.user.id, code);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error });
    }

    // Cancel PayOS payment link if applicable
    if (result.payment_provider === 'payos' && result.order_code) {
      try {
        await payosService.cancelPaymentLink(result.order_code, 'Khách hàng hủy đơn');
      } catch (cancelErr) {
        console.warn(`PayOS cancel link warning for ${result.order_code}:`, cancelErr.message);
      }
    }

    return res.json({ success: true, message: 'Đơn thanh toán đã được hủy thành công' });
  } catch (err) {
    console.error(`[${req.requestId}] Cancel checkout failed:`, err.message);
    return res.status(500).json({ success: false, error: 'Không thể hủy đơn thanh toán' });
  }
});

// Customer Orders History
app.get('/api/shop/orders', requireAuth, (req, res) => {
  try {
    const orders = db.getUserOrders(req.user.id);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. ADMIN CONTROL PANEL (RESELLER / OWNER)
// ==========================================
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = db.getAdminStats();
    const supplierBalance = await cacheService.getSupplierBalance(true);

    res.json({
      success: true,
      stats,
      supplier_balance: supplierBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = db.getAllSettings();
  res.json({
    success: true,
    settings: {
      markup_percent: settings.markup_percent,
      site_title: settings.site_title,
      site_announcement: settings.site_announcement
    }
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const {
      markup_percent,
      site_title,
      site_announcement
    } = req.body;

    if (markup_percent !== undefined) db.setSetting('markup_percent', markup_percent);
    if (site_title !== undefined) db.setSetting('site_title', site_title);
    if (site_announcement !== undefined) db.setSetting('site_announcement', site_announcement);

    // Invalidate product cache to recalculate prices
    cacheService.invalidate();

    res.json({ success: true, message: 'Đã lưu cấu hình cửa hàng thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.db.prepare('SELECT id, username, email, balance_vnd, role, created_at FROM users ORDER BY id DESC').all();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/balance', requireAdmin, (req, res) => {
  try {
    const { user_id, delta_vnd, note } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'Thiếu user_id' });

    const result = db.adjustUserBalance(
      Number(user_id),
      parseFloat(delta_vnd) || 0,
      0,
      note || 'Admin điều chỉnh số dư',
      'admin_adjust'
    );

    res.json({ success: true, message: 'Điều chỉnh số dư thành công', ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const orders = db.getAllOrders(limit);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/orders/retry-delivery', requireAdmin, async (req, res) => {
  try {
    const { checkout_id } = req.body;
    if (!checkout_id) return res.status(400).json({ success: false, error: 'Thiếu checkout_id' });

    const checkout = db.db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkout_id);
    if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });
    if (checkout.status === 'delivered') return res.json({ success: true, message: 'Đơn này đã được giao thành công.' });

    const ok = await deliverPayosPaidCheckout(checkout);
    if (ok) {
      return res.json({ success: true, message: 'Đã tự động lấy hàng từ kho và giao thành công cho khách!' });
    } else {
      const refreshed = db.db.prepare('SELECT error FROM direct_checkouts WHERE id = ?').get(checkout_id);
      return res.status(400).json({ success: false, error: refreshed?.error || 'Giao hàng từ kho thất bại' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/orders/manual-deliver', requireAdmin, (req, res) => {
  try {
    const { checkout_id, items } = req.body;
    if (!checkout_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp danh sách tài khoản hợp lệ' });
    }

    const checkout = db.db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkout_id);
    if (!checkout) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn thanh toán' });

    if (checkout.payment_provider === 'payos') {
      db.completePayosCheckout(checkout.id, items, 'MANUAL_DELIVERY');
    } else {
      db.completeMsbCheckout(checkout.id, items, 'MANUAL_DELIVERY');
    }

    res.json({ success: true, message: 'Đã cấp tài khoản thủ công cho khách thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Page Application Fallback
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, service: 'shop-bot-mmo', uptime: Math.floor(process.uptime()) });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint không tồn tại' });
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[${req.requestId}]`, err);
  return res.status(err.message === 'Origin không được phép' ? 403 : 500).json({
    success: false,
    error: 'Máy chủ không thể xử lý yêu cầu lúc này.',
    request_id: req.requestId
  });
});

// Start Server
const server = app.listen(PORT, () => {
  msbPaymentReconciler.start();
  console.log(`====================================================`);
  console.log(`🚀 SHOP BOT MMO STOREFRONT RUNNING ON http://localhost:${PORT}`);
  console.log(`⚡ ARCHITECTURE: SQLite WAL + Cache Shield + Rate Limiting + Idempotency`);
  if (!process.env.ADMIN_PASSWORD) console.warn('⚠️ Set ADMIN_PASSWORD in production and rotate any legacy admin credential.');
  console.log(`====================================================`);

  // Initialize MongoDB Atlas connection and sync
  try {
    const mongoService = require('./services/mongoService');
    mongoService.connect().then(async (mDb) => {
      if (mDb) {
        await mongoService.syncAllFromSqlite(db.db);
      }
    }).catch(e => console.warn('[MongoDB] Startup sync warning:', e.message));
  } catch (err) {
    console.warn('[MongoDB] Init error:', err.message);
  }
});

function shutdown(signal) {
  console.log(`${signal} received, closing server...`);
  server.close(async () => {
    await msbPaymentReconciler.stop();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
