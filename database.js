const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
let mongoService = null;
try {
  mongoService = require('./services/mongoService');
} catch (e) {
  // Mongo optional
}

const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable WAL Mode for high concurrency and scale
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB Cache
db.pragma('foreign_keys = ON');

// Initialize Tables
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      balance_vnd REAL DEFAULT 0,
      balance_usdt REAL DEFAULT 0,
      role TEXT DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      upstream_order_id INTEGER,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      currency TEXT NOT NULL,
      price_paid REAL NOT NULL,
      cost_price REAL NOT NULL,
      profit REAL NOT NULL,
      items TEXT, -- JSON string
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL, -- 'deposit_usdt', 'purchase', 'admin_adjust'
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      code TEXT,
      status TEXT DEFAULT 'pending', -- 'pending', 'completed', 'failed'
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      order_id INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS direct_checkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      amount_vnd INTEGER NOT NULL,
      cost_price_vnd INTEGER NOT NULL,
      qr_url TEXT NOT NULL,
      payment_provider TEXT NOT NULL DEFAULT 'msb',
      payment_transaction_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      order_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      paid_at DATETIME,
      delivered_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      amount_vnd REAL NOT NULL,
      description TEXT,
      raw_payload TEXT,
      matched_order_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, transaction_id)
    );

    CREATE TABLE IF NOT EXISTS products_override (
      product_id INTEGER PRIMARY KEY,
      custom_price_vnd REAL,
      custom_price_usdt REAL,
      markup_percent REAL,
      category TEXT DEFAULT 'other',
      is_active INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_code ON transactions(code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_type_code_unique
      ON transactions(type, code) WHERE code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reservations_user_status ON purchase_reservations(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_direct_checkouts_user_status ON direct_checkouts(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_direct_checkouts_code ON direct_checkouts(code);
    CREATE INDEX IF NOT EXISTS idx_direct_checkouts_status_expiry ON direct_checkouts(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_payment_events_match ON payment_events(matched_order_id);
  `);

  const transactionColumns = db.prepare('PRAGMA table_info(transactions)').all();
  if (!transactionColumns.some(column => column.name === 'checked_at')) {
    db.exec('ALTER TABLE transactions ADD COLUMN checked_at DATETIME');
  }

  const directCheckoutCols = db.prepare('PRAGMA table_info(direct_checkouts)').all();
  if (!directCheckoutCols.some(col => col.name === 'order_code')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN order_code INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_direct_checkouts_order_code ON direct_checkouts(order_code)');
  }
  if (!directCheckoutCols.some(col => col.name === 'payment_link_id')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN payment_link_id TEXT');
  }
  if (!directCheckoutCols.some(col => col.name === 'checkout_url')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN checkout_url TEXT');
  }
  if (!directCheckoutCols.some(col => col.name === 'bank_account_number')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN bank_account_number TEXT');
  }
  if (!directCheckoutCols.some(col => col.name === 'bank_account_name')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN bank_account_name TEXT');
  }
  if (!directCheckoutCols.some(col => col.name === 'bank_name')) {
    db.exec('ALTER TABLE direct_checkouts ADD COLUMN bank_name TEXT');
  }

  // Seed default settings if empty
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const defaultSettings = {
    markup_percent: '15', // Default profit margin: 15%
    site_title: 'Shop Bot MMO - Siêu Thị Tài Khoản Tự Động',
    site_announcement: 'Hệ thống giao dịch và nhận tài khoản tự động 24/7. Nạp USDT BEP20 theo API nhà cung cấp.',
    jwt_secret: crypto.randomBytes(48).toString('hex')
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    if (!getSetting.get(k)) {
      setSetting.run(k, v);
    }
  }
  const announcement = getSetting.get('site_announcement');
  if (announcement && /USDT|BEP20/i.test(announcement.value || '')) {
    setSetting.run('site_announcement', 'Thanh toán VietQR MSB bằng VNĐ và nhận sản phẩm tự động sau khi chuyển khoản được xác nhận.');
  }

  // Seed default Admin user if no admin exists
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminExists) {
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(adminPassword, salt);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, balance_vnd, balance_usdt, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('admin', 'admin@shopbot.local', hash, 1000000, 100, 'admin');
    console.log(`✅ Created admin account: admin / ${adminPassword}`);
    console.log('⚠️ Save this password now. It is only printed on first initialization.');
  } else if (process.env.ADMIN_PASSWORD) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, bcrypt.genSaltSync(10));
    db.prepare("UPDATE users SET password_hash = ? WHERE role = 'admin' AND username = 'admin'").run(hash);
  }
}

initDb();

module.exports = {
  db,

  // Settings
  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const res = {};
    for (const r of rows) res[r.key] = r.value;
    return res;
  },

  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  },

  // Users
  getUserById(id) {
    return db.prepare('SELECT id, username, email, balance_vnd, balance_usdt, role, created_at FROM users WHERE id = ?').get(id);
  },

  getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  },

  createUser(username, email, password) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    const info = db.prepare(`
      INSERT INTO users (username, email, password_hash, balance_vnd, balance_usdt, role)
      VALUES (?, ?, ?, 0, 0, 'customer')
    `).run(username, email || null, hash);
    const user = this.getUserById(info.lastInsertRowid);
    if (mongoService && user) {
      mongoService.syncUser(user).catch(() => {});
    }
    return user;
  },

  verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
  },

  // Atomic Balance Adjustment
  adjustUserBalance(userId, deltaVnd, deltaUsdt, note = '', type = 'admin_adjust', code = null) {
    const tx = db.transaction(() => {
      const user = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(userId);
      if (!user) throw new Error('Không tìm thấy người dùng');

      const normalizedDeltaVnd = Number(deltaVnd);
      const normalizedDeltaUsdt = Number(deltaUsdt);
      if (!Number.isFinite(normalizedDeltaVnd) || !Number.isFinite(normalizedDeltaUsdt)) {
        throw new Error('Số tiền điều chỉnh không hợp lệ');
      }

      const newVnd = Math.max(0, user.balance_vnd + normalizedDeltaVnd);
      const newUsdt = Math.max(0, user.balance_usdt + normalizedDeltaUsdt);
      const actualDeltaVnd = newVnd - user.balance_vnd;
      const actualDeltaUsdt = newUsdt - user.balance_usdt;

      db.prepare('UPDATE users SET balance_vnd = ?, balance_usdt = ? WHERE id = ?').run(newVnd, newUsdt, userId);

      if (actualDeltaVnd !== 0) {
        db.prepare(`
          INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
          VALUES (?, ?, ?, 'vnd', 'completed', ?, ?)
        `).run(userId, type, Math.abs(actualDeltaVnd), note, code);
      }

      if (actualDeltaUsdt !== 0) {
        db.prepare(`
          INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
          VALUES (?, ?, ?, 'usdt', 'completed', ?, ?)
        `).run(userId, type, Math.abs(actualDeltaUsdt), note, code);
      }

      return { balance_vnd: newVnd, balance_usdt: newUsdt };
    });

    return tx();
  },

  completeUsdtDeposit(userId, code, creditAmount) {
    const tx = db.transaction(() => {
      const pending = db.prepare(`
        SELECT id, status, amount FROM transactions
        WHERE code = ? AND user_id = ? AND type = 'deposit_usdt'
        ORDER BY id DESC LIMIT 1
      `).get(code, userId);
      if (!pending || pending.status !== 'pending') {
        return { credited: false, user: this.getUserById(userId) };
      }

      const claimed = db.prepare("UPDATE transactions SET status = 'processing' WHERE id = ? AND status = 'pending'").run(pending.id);
      if (claimed.changes !== 1) return { credited: false, user: this.getUserById(userId) };

      const parsedCreditAmount = Number(creditAmount);
      const amount = Number.isFinite(parsedCreditAmount) && parsedCreditAmount > 0
        ? Number(parsedCreditAmount.toFixed(8))
        : Number(pending.amount);
      db.prepare('UPDATE users SET balance_usdt = balance_usdt + ? WHERE id = ?').run(amount, userId);
      db.prepare("UPDATE transactions SET status = 'completed', amount = ?, note = ? WHERE id = ?")
        .run(amount, `Xác nhận nạp ${amount} USDT`, pending.id);
      return { credited: true, amount, user: this.getUserById(userId) };
    });
    return tx.immediate();
  },

  createPendingDeposit(userId, type, amount, currency, code, note = '') {
    const normalizedAmount = Number(amount);
    const normalizedCode = String(code || '').trim();
    if (type !== 'deposit_usdt' || currency !== 'usdt' || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0 || !normalizedCode) {
      throw new Error('Thông tin lệnh nạp không hợp lệ');
    }

    const info = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, currency, status, code, note)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(userId, type, normalizedAmount, currency, normalizedCode, note);
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  },

  getDepositByCode(userId, type, code) {
    return db.prepare(`
      SELECT id, user_id, type, amount, currency, status, code, note, created_at
      FROM transactions
      WHERE user_id = ? AND type = ? AND code = ?
      ORDER BY id DESC LIMIT 1
    `).get(userId, type, String(code || '').trim());
  },

  getPendingUsdtDeposits(limit = 25) {
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const tx = db.transaction(() => {
      const deposits = db.prepare(`
        SELECT id, user_id, amount, code, status, created_at
        FROM transactions
        WHERE type = 'deposit_usdt' AND status = 'pending' AND code IS NOT NULL
          AND (checked_at IS NULL OR checked_at < datetime('now', '-15 seconds'))
        ORDER BY COALESCE(checked_at, '1970-01-01') ASC, id ASC
        LIMIT ?
      `).all(safeLimit);

      if (deposits.length > 0) {
        const markChecked = db.prepare("UPDATE transactions SET checked_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'");
        for (const deposit of deposits) markChecked.run(deposit.id);
      }
      return deposits;
    });
    return tx.immediate();
  },

  createMsbCheckout({ idempotencyKey, code, userId, product, quantity, amountVnd, costPriceVnd, qrUrl, ttlMinutes = 30 }) {
    const tx = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM direct_checkouts WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.user_id !== userId) throw new Error('Mã chống trùng giao dịch đã được sử dụng');
        return { replay: true, checkout: existing };
      }

      const info = db.prepare(`
        INSERT INTO direct_checkouts (
          idempotency_key, code, user_id, product_id, product_name, quantity,
          amount_vnd, cost_price_vnd, qr_url, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
      `).run(
        idempotencyKey,
        code,
        userId,
        product.id,
        product.name,
        quantity,
        amountVnd,
        costPriceVnd,
        qrUrl,
        `+${ttlMinutes} minutes`
      );
      return {
        replay: false,
        checkout: db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(info.lastInsertRowid)
      };
    });
    return tx.immediate();
  },

  createPayosCheckout({
    idempotencyKey,
    orderCode,
    code,
    userId,
    product,
    quantity,
    amountVnd,
    costPriceVnd,
    qrUrl,
    paymentLinkId = null,
    checkoutUrl = null,
    bankAccountNumber = null,
    bankAccountName = null,
    bankName = null,
    ttlMinutes = 15
  }) {
    const tx = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM direct_checkouts WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.user_id !== userId) throw new Error('Mã chống trùng giao dịch đã được sử dụng');
        return { replay: true, checkout: existing };
      }

      const info = db.prepare(`
        INSERT INTO direct_checkouts (
          idempotency_key, order_code, code, user_id, product_id, product_name, quantity,
          amount_vnd, cost_price_vnd, qr_url, payment_provider, payment_link_id,
          checkout_url, bank_account_number, bank_account_name, bank_name,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'payos', ?, ?, ?, ?, ?, datetime('now', ?))
      `).run(
        idempotencyKey,
        orderCode,
        code,
        userId,
        product.id,
        product.name,
        quantity,
        amountVnd,
        costPriceVnd,
        qrUrl,
        paymentLinkId,
        checkoutUrl,
        bankAccountNumber,
        bankAccountName,
        bankName,
        `+${ttlMinutes} minutes`
      );

      return {
        replay: false,
        checkout: db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(info.lastInsertRowid)
      };
    });
    return tx.immediate();
  },

  getPayosCheckoutByOrderCode(orderCode) {
    return db.prepare(`
      SELECT * FROM direct_checkouts
      WHERE order_code = ? AND payment_provider = 'payos'
      LIMIT 1
    `).get(Number(orderCode));
  },

  getPayosCheckoutByCode(userId, code) {
    return db.prepare(`
      SELECT * FROM direct_checkouts
      WHERE user_id = ? AND code = ?
      LIMIT 1
    `).get(userId, String(code || '').trim().toUpperCase());
  },

  claimPayosPaymentEvent({ orderCode, transactionId, amountVnd, description, rawPayload }) {
    const tx = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO payment_events (
          provider, transaction_id, amount_vnd, description, raw_payload
        ) VALUES ('payos', ?, ?, ?, ?)
      `).run(String(transactionId), amountVnd, description, JSON.stringify(rawPayload || {}));
      if (inserted.changes !== 1) return { status: 'duplicate' };

      const checkout = db.prepare('SELECT * FROM direct_checkouts WHERE order_code = ?').get(Number(orderCode));
      if (!checkout) return { status: 'order_not_found' };

      db.prepare(`
        UPDATE payment_events SET matched_order_id = ?
        WHERE provider = 'payos' AND transaction_id = ?
      `).run(checkout.id, String(transactionId));

      if (checkout.status !== 'pending') return { status: 'order_terminal', checkout };
      if (Number(amountVnd) < Number(checkout.amount_vnd)) {
        db.prepare(`
          UPDATE direct_checkouts
          SET status = 'amount_mismatch', payment_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
              error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).run(String(transactionId), `Đã nhận ${amountVnd} VNĐ, đơn yêu cầu ${checkout.amount_vnd} VNĐ`, checkout.id);
        return { status: 'amount_mismatch' };
      }

      const claimed = db.prepare(`
        UPDATE direct_checkouts
        SET status = 'processing', payment_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(String(transactionId), checkout.id);
      if (claimed.changes !== 1) return { status: 'already_claimed' };

      return {
        status: 'claimed',
        checkout: db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkout.id)
      };
    });
    return tx.immediate();
  },

  completePayosCheckout(checkoutId, items, upstreamOrderId = null) {
    const tx = db.transaction(() => {
      const checkout = db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkoutId);
      if (!checkout) throw new Error('Không tìm thấy đơn thanh toán PayOS');
      if (checkout.status === 'delivered') return { replay: true, orderId: checkout.order_id };
      if (checkout.status !== 'processing' && checkout.status !== 'pending' && checkout.status !== 'paid_pending_delivery') {
        throw new Error(`Đơn PayOS đang ở trạng thái ${checkout.status}`);
      }

      const profit = Math.max(0, checkout.amount_vnd - checkout.cost_price_vnd);
      const orderInfo = db.prepare(`
        INSERT INTO orders (
          user_id, upstream_order_id, product_id, product_name, quantity,
          currency, price_paid, cost_price, profit, items, status
        ) VALUES (?, ?, ?, ?, ?, 'vnd', ?, ?, ?, ?, 'completed')
      `).run(
        checkout.user_id,
        upstreamOrderId,
        checkout.product_id,
        checkout.product_name,
        checkout.quantity,
        checkout.amount_vnd,
        checkout.cost_price_vnd,
        profit,
        JSON.stringify(items)
      );

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
        VALUES (?, 'purchase_vietqr', ?, 'vnd', 'completed', ?, ?)
      `).run(
        checkout.user_id,
        checkout.amount_vnd,
        `Thanh toán PayOS ${checkout.quantity}x ${checkout.product_name}`,
        checkout.code
      );

      db.prepare(`
        UPDATE direct_checkouts
        SET status = 'delivered', order_id = ?, delivered_at = CURRENT_TIMESTAMP,
            error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(orderInfo.lastInsertRowid, checkout.id);

      return { replay: false, orderId: orderInfo.lastInsertRowid };
    });
    return tx.immediate();
  },

  markPayosCheckoutDeliveryFailed(checkoutId, errorMessage) {
    return db.prepare(`
      UPDATE direct_checkouts
      SET status = 'paid_pending_delivery', error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(errorMessage || 'Nhà cung cấp chưa thể giao sản phẩm').slice(0, 500), checkoutId).changes === 1;
  },

  getMsbCheckoutByCode(userId, code) {
    return db.prepare(`
      SELECT * FROM direct_checkouts
      WHERE user_id = ? AND code = ? AND payment_provider = 'msb'
      LIMIT 1
    `).get(userId, String(code || '').trim().toUpperCase());
  },

  claimMsbPaymentEvent(event) {
    const tx = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO payment_events (
          provider, transaction_id, amount_vnd, description, raw_payload
        ) VALUES ('msb', ?, ?, ?, ?)
      `).run(event.transactionId, event.amountVnd, event.description, event.rawPayload);
      if (inserted.changes !== 1) return { status: 'duplicate' };

      const codeMatch = String(event.description || '').toUpperCase().match(/\bP[A-Z0-9]{1,4}[0-9A-F]{10}\b/);
      if (!codeMatch) return { status: 'no_order_code' };

      const checkout = db.prepare('SELECT * FROM direct_checkouts WHERE code = ?').get(codeMatch[0]);
      if (!checkout) return { status: 'order_not_found' };
      db.prepare(`
        UPDATE payment_events SET matched_order_id = ?
        WHERE provider = 'msb' AND transaction_id = ?
      `).run(checkout.id, event.transactionId);

      if (checkout.status !== 'pending') return { status: 'order_terminal', checkout };
      if (Number(event.amountVnd) !== Number(checkout.amount_vnd)) {
        db.prepare(`
          UPDATE direct_checkouts
          SET status = 'amount_mismatch', payment_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
              error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).run(event.transactionId, `Đã nhận ${event.amountVnd} VNĐ, đơn yêu cầu ${checkout.amount_vnd} VNĐ`, checkout.id);
        return { status: 'amount_mismatch' };
      }

      const expired = db.prepare('SELECT expires_at <= CURRENT_TIMESTAMP AS expired FROM direct_checkouts WHERE id = ?').get(checkout.id);
      if (expired?.expired) {
        db.prepare(`
          UPDATE direct_checkouts
          SET status = 'paid_late', payment_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
              error = 'Thanh toán được ghi nhận sau khi đơn hết hạn', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).run(event.transactionId, checkout.id);
        return { status: 'paid_late' };
      }

      const claimed = db.prepare(`
        UPDATE direct_checkouts
        SET status = 'processing', payment_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(event.transactionId, checkout.id);
      if (claimed.changes !== 1) return { status: 'already_claimed' };
      return {
        status: 'claimed',
        checkout: db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkout.id)
      };
    });
    return tx.immediate();
  },

  completeMsbCheckout(checkoutId, items, upstreamOrderId = null) {
    const tx = db.transaction(() => {
      const checkout = db.prepare('SELECT * FROM direct_checkouts WHERE id = ?').get(checkoutId);
      if (!checkout) throw new Error('Không tìm thấy đơn thanh toán MSB');
      if (checkout.status === 'delivered') return { replay: true, orderId: checkout.order_id };
      if (checkout.status !== 'processing' && checkout.status !== 'pending' && checkout.status !== 'paid_pending_delivery') {
        throw new Error(`Đơn MSB không ở trạng thái hợp lệ để giao hàng: ${checkout.status}`);
      }

      const profit = Math.max(0, checkout.amount_vnd - checkout.cost_price_vnd);
      const orderInfo = db.prepare(`
        INSERT INTO orders (
          user_id, upstream_order_id, product_id, product_name, quantity,
          currency, price_paid, cost_price, profit, items, status
        ) VALUES (?, ?, ?, ?, ?, 'vnd', ?, ?, ?, ?, 'completed')
      `).run(
        checkout.user_id,
        upstreamOrderId,
        checkout.product_id,
        checkout.product_name,
        checkout.quantity,
        checkout.amount_vnd,
        checkout.cost_price_vnd,
        profit,
        JSON.stringify(items)
      );

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
        VALUES (?, 'purchase_msb', ?, 'vnd', 'completed', ?, ?)
      `).run(
        checkout.user_id,
        checkout.amount_vnd,
        `Thanh toán MSB ${checkout.quantity}x ${checkout.product_name}`,
        checkout.code
      );

      db.prepare(`
        UPDATE direct_checkouts
        SET status = 'delivered', order_id = ?, delivered_at = CURRENT_TIMESTAMP,
            error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing'
      `).run(orderInfo.lastInsertRowid, checkout.id);
      return { replay: false, orderId: orderInfo.lastInsertRowid };
    });
    return tx.immediate();
  },

  markMsbCheckoutDeliveryFailed(checkoutId, errorMessage) {
    return db.prepare(`
      UPDATE direct_checkouts
      SET status = 'paid_pending_delivery', error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).run(String(errorMessage || 'Nhà cung cấp chưa thể giao sản phẩm').slice(0, 500), checkoutId).changes === 1;
  },

  expirePendingMsbCheckouts() {
    return db.prepare(`
      UPDATE direct_checkouts
      SET status = 'expired', error = 'Đơn hết hạn trước khi nhận được thanh toán', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending' AND expires_at <= CURRENT_TIMESTAMP
    `).run().changes;
  },

  cancelCheckout(userId, code) {
    const checkout = db.prepare(`
      SELECT id, status, payment_provider, order_code FROM direct_checkouts
      WHERE user_id = ? AND code = ? AND status = 'pending'
    `).get(userId, String(code || '').trim().toUpperCase());

    if (!checkout) return { success: false, error: 'Không tìm thấy đơn thanh toán đang chờ' };

    db.prepare(`
      UPDATE direct_checkouts
      SET status = 'cancelled', error = 'Khách hàng đã hủy đơn', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(checkout.id);

    return {
      success: true,
      payment_provider: checkout.payment_provider,
      order_code: checkout.order_code
    };
  },

  failUsdtDeposit(userId, code, reason = 'Lệnh nạp đã hết hạn') {
    return db.prepare(`
      UPDATE transactions SET status = 'failed', note = ?
      WHERE user_id = ? AND type = 'deposit_usdt' AND code = ? AND status = 'pending'
    `).run(String(reason).slice(0, 500), userId, String(code || '').trim()).changes === 1;
  },

  expireStaleUsdtDeposits(maxAgeMinutes = 20) {
    const minutes = Math.min(Math.max(Number(maxAgeMinutes) || 20, 10), 1440);
    return db.prepare(`
      UPDATE transactions SET status = 'failed', note = 'Lệnh nạp hết hạn trước khi được xác nhận'
      WHERE type = 'deposit_usdt' AND status = 'pending'
        AND created_at < datetime('now', ?)
    `).run(`-${minutes} minutes`).changes;
  },

  reservePurchaseBalance(userId, productId, quantity, currency, amount, idempotencyKey) {
    const tx = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM purchase_reservations WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { replay: true, reservation: existing };

      const user = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(userId);
      if (!user) throw new Error('Không tìm thấy người dùng');
      if (currency === 'vnd') {
        if (user.balance_vnd < amount) throw new Error('Số dư ví VNĐ không đủ để thanh toán');
        db.prepare('UPDATE users SET balance_vnd = balance_vnd - ? WHERE id = ?').run(amount, userId);
      } else {
        if (user.balance_usdt < amount) throw new Error('Số dư ví USDT không đủ để thanh toán');
        db.prepare('UPDATE users SET balance_usdt = balance_usdt - ? WHERE id = ?').run(amount, userId);
      }

      const info = db.prepare(`
        INSERT INTO purchase_reservations (idempotency_key, user_id, product_id, quantity, currency, amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(idempotencyKey, userId, productId, quantity, currency, amount);
      const balances = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(userId);
      return { replay: false, reservationId: info.lastInsertRowid, ...balances };
    });
    return tx.immediate();
  },

  failPurchaseReservation(reservationId, errorMessage) {
    const tx = db.transaction(() => {
      const reservation = db.prepare('SELECT * FROM purchase_reservations WHERE id = ?').get(reservationId);
      if (!reservation || reservation.status !== 'pending') return false;
      const balanceColumn = reservation.currency === 'vnd' ? 'balance_vnd' : 'balance_usdt';
      db.prepare(`UPDATE users SET ${balanceColumn} = ${balanceColumn} + ? WHERE id = ?`).run(reservation.amount, reservation.user_id);
      db.prepare("UPDATE purchase_reservations SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(String(errorMessage || 'Upstream purchase failed').slice(0, 500), reservationId);
      return true;
    });
    return tx.immediate();
  },

  completePurchaseReservation(reservationId, product, costPrice, items, upstreamOrderId = null) {
    const tx = db.transaction(() => {
      const reservation = db.prepare('SELECT * FROM purchase_reservations WHERE id = ?').get(reservationId);
      if (!reservation) throw new Error('Không tìm thấy giao dịch giữ chỗ');
      if (reservation.status === 'completed') {
        const balances = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(reservation.user_id);
        return { orderId: reservation.order_id, ...balances, replay: true };
      }
      if (reservation.status !== 'pending') throw new Error('Giao dịch giữ chỗ không còn hiệu lực');

      const profit = Math.max(0, reservation.amount - costPrice);
      const orderInfo = db.prepare(`
        INSERT INTO orders (user_id, upstream_order_id, product_id, product_name, quantity, currency, price_paid, cost_price, profit, items, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(reservation.user_id, upstreamOrderId, reservation.product_id, product.name, reservation.quantity,
        reservation.currency, reservation.amount, costPrice, profit, JSON.stringify(items));

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
        VALUES (?, 'purchase', ?, ?, 'completed', ?, ?)
      `).run(reservation.user_id, reservation.amount, reservation.currency,
        `Mua ${reservation.quantity}x ${product.name}`, `ORDER_${orderInfo.lastInsertRowid}`);

      db.prepare("UPDATE purchase_reservations SET status = 'completed', order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(orderInfo.lastInsertRowid, reservationId);
      const balances = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(reservation.user_id);
      return { orderId: orderInfo.lastInsertRowid, ...balances, replay: false };
    });
    return tx.immediate();
  },

  getOrderById(orderId, userId = null) {
    const order = userId
      ? db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId)
      : db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return null;
    return { ...order, items: order.items ? JSON.parse(order.items) : [] };
  },

  // Atomic Purchase Transaction (Deduct User Balance & Save Order)
  processPurchaseTransaction(userId, product, quantity, currency, pricePaid, costPrice, items, upstreamOrderId = null) {
    const tx = db.transaction(() => {
      const user = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(userId);
      if (!user) throw new Error('Không tìm thấy người dùng');

      if (currency === 'vnd') {
        if (user.balance_vnd < pricePaid) {
          throw new Error('Số dư ví VNĐ không đủ để thanh toán');
        }
        db.prepare('UPDATE users SET balance_vnd = balance_vnd - ? WHERE id = ?').run(pricePaid, userId);
      } else {
        if (user.balance_usdt < pricePaid) {
          throw new Error('Số dư ví USDT không đủ để thanh toán');
        }
        db.prepare('UPDATE users SET balance_usdt = balance_usdt - ? WHERE id = ?').run(pricePaid, userId);
      }

      const profit = Math.max(0, pricePaid - costPrice);

      const orderInfo = db.prepare(`
        INSERT INTO orders (user_id, upstream_order_id, product_id, product_name, quantity, currency, price_paid, cost_price, profit, items, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(
        userId,
        upstreamOrderId,
        product.id,
        product.name,
        quantity,
        currency,
        pricePaid,
        costPrice,
        profit,
        JSON.stringify(items)
      );

      // Record transaction
      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, currency, status, note, code)
        VALUES (?, 'purchase', ?, ?, 'completed', ?, ?)
      `).run(
        userId,
        pricePaid,
        currency,
        `Mua ${quantity}x ${product.name}`,
        `ORDER_${orderInfo.lastInsertRowid}`
      );

      const updatedUser = db.prepare('SELECT balance_vnd, balance_usdt FROM users WHERE id = ?').get(userId);

      return {
        orderId: orderInfo.lastInsertRowid,
        balance_vnd: updatedUser.balance_vnd,
        balance_usdt: updatedUser.balance_usdt
      };
    });

    return tx();
  },

  // Get User Orders (Completed orders + unfulfilled/pending/paid checkouts)
  getUserOrders(userId) {
    const completedOrders = db.prepare(`
      SELECT 
        o.id,
        o.user_id,
        o.product_id,
        o.product_name,
        o.quantity,
        o.currency,
        o.price_paid,
        o.cost_price,
        o.profit,
        o.items,
        o.status,
        o.created_at,
        dc.id as checkout_id,
        dc.code as checkout_code,
        dc.order_code as payos_order_code,
        dc.payment_provider,
        dc.qr_url,
        dc.status as checkout_status,
        dc.error as checkout_error
      FROM orders o
      LEFT JOIN direct_checkouts dc ON dc.order_id = o.id
      WHERE o.user_id = ?
      ORDER BY o.id DESC
    `).all(userId);

    const checkouts = db.prepare(`
      SELECT 
        NULL as id,
        dc.id as checkout_id,
        dc.user_id,
        dc.product_id,
        dc.product_name,
        dc.quantity,
        'vnd' as currency,
        dc.amount_vnd as price_paid,
        dc.cost_price_vnd as cost_price,
        MAX(0, dc.amount_vnd - dc.cost_price_vnd) as profit,
        NULL as items,
        dc.status as status,
        dc.created_at,
        dc.code as checkout_code,
        dc.order_code as payos_order_code,
        dc.payment_provider,
        dc.qr_url,
        dc.checkout_url,
        dc.status as checkout_status,
        dc.error as checkout_error,
        dc.expires_at
      FROM direct_checkouts dc
      WHERE dc.user_id = ? AND dc.order_id IS NULL
      ORDER BY dc.id DESC
    `).all(userId);

    const combined = [
      ...completedOrders.map(o => ({
        ...o,
        items: o.items ? JSON.parse(o.items) : [],
        type: 'order'
      })),
      ...checkouts.map(c => ({
        ...c,
        items: [],
        type: 'checkout'
      }))
    ];

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return combined;
  },

  // Get All Orders (Admin)
  getAllOrders(limit = 100) {
    const completedOrders = db.prepare(`
      SELECT 
        o.id,
        o.user_id,
        u.username,
        u.email,
        o.product_id,
        o.product_name,
        o.quantity,
        o.currency,
        o.price_paid,
        o.cost_price,
        o.profit,
        o.items,
        o.status,
        o.created_at,
        dc.id as checkout_id,
        dc.code as checkout_code,
        dc.order_code as payos_order_code,
        dc.payment_provider,
        dc.status as checkout_status,
        dc.error as checkout_error
      FROM orders o
      JOIN users u ON o.user_id = u.id
      LEFT JOIN direct_checkouts dc ON dc.order_id = o.id
      ORDER BY o.id DESC
      LIMIT ?
    `).all(limit);

    const checkouts = db.prepare(`
      SELECT 
        NULL as id,
        dc.id as checkout_id,
        dc.user_id,
        u.username,
        u.email,
        dc.product_id,
        dc.product_name,
        dc.quantity,
        'vnd' as currency,
        dc.amount_vnd as price_paid,
        dc.cost_price_vnd as cost_price,
        MAX(0, dc.amount_vnd - dc.cost_price_vnd) as profit,
        NULL as items,
        dc.status as status,
        dc.created_at,
        dc.code as checkout_code,
        dc.order_code as payos_order_code,
        dc.payment_provider,
        dc.qr_url,
        dc.checkout_url,
        dc.status as checkout_status,
        dc.error as checkout_error,
        dc.expires_at
      FROM direct_checkouts dc
      JOIN users u ON dc.user_id = u.id
      WHERE dc.order_id IS NULL
      ORDER BY dc.id DESC
      LIMIT ?
    `).all(limit);

    const combined = [
      ...completedOrders.map(o => ({
        ...o,
        items: o.items ? JSON.parse(o.items) : [],
        type: 'order'
      })),
      ...checkouts.map(c => ({
        ...c,
        items: [],
        type: 'checkout'
      }))
    ];

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return combined.slice(0, limit);
  },

  // Product Override and Category
  getProductOverride(productId) {
    return db.prepare('SELECT * FROM products_override WHERE product_id = ?').get(productId);
  },

  getAllProductOverrides() {
    return db.prepare('SELECT * FROM products_override').all();
  },

  setProductOverride(productId, data) {
    db.prepare(`
      INSERT OR REPLACE INTO products_override (product_id, custom_price_vnd, custom_price_usdt, markup_percent, category, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      productId,
      data.custom_price_vnd || null,
      data.custom_price_usdt || null,
      data.markup_percent || null,
      data.category || 'other',
      data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1
    );
  },

  // Admin Stats
  getAdminStats() {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    const financials = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN currency = 'vnd' THEN price_paid ELSE 0 END), 0) as revenue_vnd,
        COALESCE(SUM(CASE WHEN currency = 'usdt' THEN price_paid ELSE 0 END), 0) as revenue_usdt,
        COALESCE(SUM(CASE WHEN currency = 'vnd' THEN profit ELSE 0 END), 0) as profit_vnd,
        COALESCE(SUM(CASE WHEN currency = 'usdt' THEN profit ELSE 0 END), 0) as profit_usdt
      FROM orders
    `).get();

    return {
      totalUsers,
      totalOrders,
      ...financials
    };
  }
};
