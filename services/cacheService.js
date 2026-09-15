const upstreamService = require('./upstreamService');
const db = require('../database');

const STOREFRONT_PRODUCT_NAMES = new Set([
  'link gemini pro 18m',
  'capcut pro team 1m (fw)',
  'capcut pro 7d (fw)'
]);

class CacheService {
  constructor() {
    this.productsCache = null;
    this.productsCacheTime = 0;
    this.productsCacheTTL = 20 * 1000; // 20 seconds
    this.isRefreshingProducts = false;

    this.rateCache = null;
    this.rateCacheTime = 0;
    this.rateCacheTTL = 60 * 1000; // 60 seconds

    this.supplierBalanceCache = null;
    this.supplierBalanceCacheTime = 0;
    this.supplierBalanceCacheTTL = 30 * 1000; // 30 seconds
  }

  // Determine category based on product name
  detectCategory(name) {
    const lower = (name || '').toLowerCase();
    if (lower.includes('gpt') || lower.includes('chatgpt') || lower.includes('grok') || lower.includes('gemini') || lower.includes('elevenlab') || lower.includes('claude') || lower.includes('ai')) {
      return 'ai';
    }
    if (lower.includes('capcut') || lower.includes('canva') || lower.includes('adobe') || lower.includes('video') || lower.includes('design')) {
      return 'design';
    }
    if (lower.includes('ms365') || lower.includes('microsoft') || lower.includes('office') || lower.includes('linkedin') || lower.includes('mail')) {
      return 'office';
    }
    if (lower.includes('doulingo') || lower.includes('duolingo') || lower.includes('elsa') || lower.includes('course')) {
      return 'edu';
    }
    return 'other';
  }

  // Format and apply markup profit margin to products
  applyMarkup(rawProducts, usdtRate) {
    const defaultMarkup = parseFloat(db.getSetting('markup_percent') || '15') / 100;
    const overrides = db.getAllProductOverrides();
    const overrideMap = new Map(overrides.map(o => [o.product_id, o]));

    return rawProducts
      .filter(product => STOREFRONT_PRODUCT_NAMES.has((product.name || '').trim().toLowerCase()))
      .map(p => {
      const override = overrideMap.get(p.id);
      let markup = defaultMarkup;
      let category = this.detectCategory(p.name);
      let customVnd = null;
      let customUsdt = null;
      let isActive = true;

      if (override) {
        if (override.markup_percent !== null && override.markup_percent !== undefined) {
          markup = parseFloat(override.markup_percent) / 100;
        }
        if (override.category) category = override.category;
        if (override.custom_price_vnd) customVnd = override.custom_price_vnd;
        if (override.custom_price_usdt) customUsdt = override.custom_price_usdt;
        if (override.is_active !== undefined) isActive = !!override.is_active;
      }

      // Calculate selling price with markup rounded up to nearest 1,000 VND
      const costVnd = p.price_vnd;
      const costUsdt = p.price_usdt;

      const sellingVnd = customVnd !== null
        ? customVnd
        : Math.ceil((costVnd * (1 + markup)) / 1000) * 1000;

      const sellingUsdt = customUsdt !== null
        ? customUsdt
        : +(costUsdt * (1 + markup)).toFixed(2);

      return {
        id: p.id,
        name: p.name,
        description: p.description || '',
        stock: p.stock || 0,
        price_vnd: sellingVnd,
        price_usdt: sellingUsdt,
        cost_price_vnd: costVnd,
        cost_price_usdt: costUsdt,
        profit_vnd: Math.max(0, sellingVnd - costVnd),
        profit_usdt: +(Math.max(0, sellingUsdt - costUsdt)).toFixed(2),
        category,
        is_active: isActive
      };
      })
      .filter(p => p.is_active);
  }

  // Get Products with Stale-While-Revalidate caching
  async getCatalog(forceRefresh = false) {
    const now = Date.now();
    const isExpired = !this.productsCache || (now - this.productsCacheTime > this.productsCacheTTL);

    if (forceRefresh || (!this.productsCache && !this.isRefreshingProducts)) {
      await this.refreshProducts();
    } else if (isExpired && !this.isRefreshingProducts) {
      // Trigger background refresh without blocking client
      this.refreshProducts().catch(err => console.warn('Background products refresh failed:', err.message));
    }

    return this.productsCache || { products: [], usdt_rate: 25000 };
  }

  async refreshProducts() {
    this.isRefreshingProducts = true;
    try {
      const data = await upstreamService.getProducts();
      const catalog = this.applyMarkup(data.products, data.usdt_rate);

      this.productsCache = {
        products: catalog,
        usdt_rate: data.usdt_rate || 25000,
        updated_at: new Date().toISOString()
      };
      this.productsCacheTime = Date.now();
    } finally {
      this.isRefreshingProducts = false;
    }
  }

  // Get Exchange Rate with cache
  async getExchangeRate() {
    const now = Date.now();
    if (this.rateCache && (now - this.rateCacheTime < this.rateCacheTTL)) {
      return this.rateCache;
    }

    try {
      const rate = await upstreamService.getRate();
      this.rateCache = rate;
      this.rateCacheTime = now;
      return rate;
    } catch (e) {
      return this.rateCache || { usdt_vnd: 25000, description: '1 USDT = 25,000 VND' };
    }
  }

  // Get Supplier Balance with cache
  async getSupplierBalance(force = false) {
    const now = Date.now();
    if (!force && this.supplierBalanceCache && (now - this.supplierBalanceCacheTime < this.supplierBalanceCacheTTL)) {
      return this.supplierBalanceCache;
    }

    try {
      const bal = await upstreamService.getSupplierBalance();
      this.supplierBalanceCache = bal;
      this.supplierBalanceCacheTime = now;
      return bal;
    } catch (e) {
      return this.supplierBalanceCache || { success: false, balance_vnd: 0, balance_usdt: 0, error: e.message };
    }
  }

  // Invalidate cache immediately (e.g. when admin changes markup)
  invalidate() {
    this.productsCacheTime = 0;
  }
}

module.exports = new CacheService();
