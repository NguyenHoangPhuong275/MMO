require('dotenv').config();

const API_BASE_URL = process.env.API_BASE_URL || 'https://tunvnmmo.duckdns.org';
const API_KEY = process.env.API_KEY || '';

async function request(endpoint, options = {}) {
  if (!API_KEY && !options.public) {
    throw new Error('Chưa cấu hình API Key của chủ shop');
  }

  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (!options.public && API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }

    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  // 1. Get raw products list
  async getProducts() {
    const { status, ok, data } = await request('/api/products');
    if (!ok || !data || !Array.isArray(data.products)) {
      throw new Error((data && data.error) || 'Không thể lấy danh sách sản phẩm từ nhà cung cấp');
    }
    return {
      products: data.products,
      usdt_rate: data.usdt_rate || 25000
    };
  },

  // 2. Get exchange rate
  async getRate() {
    const { status, ok, data } = await request('/api/rate', { public: true });
    if (!ok || !data || !data.success) {
      return { usdt_vnd: 25000, description: '1 USDT = 25,000 VND' };
    }
    return data;
  },

  // 3. Get supplier wallet balance
  async getSupplierBalance() {
    const { status, ok, data } = await request('/api/balance');
    if (!ok || !data || !data.success) {
      throw new Error((data && data.error) || 'Không thể kiểm tra số dư tổng kho');
    }
    return data;
  },

  // 4. Create USDT Deposit via supplier
  async createDeposit(amount) {
    const { status, ok, data } = await request('/api/deposit', {
      method: 'POST',
      body: {
        amount: Number(amount),
        currency: 'usdt'
      }
    });

    if (!ok || !data || !data.success) {
      throw new Error((data && (data.error || data.detail)) || 'Tạo lệnh nạp USDT thất bại');
    }
    return data;
  },

  // 5. Check USDT Deposit status
  async checkDepositStatus(code) {
    const { ok, data } = await request(`/api/deposit/status?code=${encodeURIComponent(code)}`);
    if (!ok || !data || data.success !== true || !data.deposit) {
      throw new Error((data && (data.error || data.detail || data.message)) || 'Không thể kiểm tra trạng thái nạp USDT');
    }
    return data;
  },

  // 6. Buy product from supplier
  async buyProduct(productId, quantity, currency = 'vnd') {
    const { status, ok, data } = await request('/api/buy', {
      method: 'POST',
      body: {
        product_id: Number(productId),
        quantity: Number(quantity),
        currency: currency === 'usdt' ? 'usdt' : 'vnd'
      }
    });

    if (!ok || !data || !data.success) {
      const errMsg = (data && (data.error || data.detail || data.message)) || 'Mua hàng từ tổng kho thất bại';
      throw new Error(errMsg);
    }
    return data;
  }
};
