/**
 * Shop Bot MMO - High-Scale E-Commerce Storefront & Admin Platform
 */

function loadStoredMsbCheckout() {
  try {
    const value = JSON.parse(localStorage.getItem('shop_active_msb_checkout') || 'null');
    return value && value.code ? value : null;
  } catch (error) {
    localStorage.removeItem('shop_active_msb_checkout');
    return null;
  }
}

// Global State
const state = {
  token: localStorage.getItem('shop_token') || '',
  user: null,
  products: [],
  filteredProducts: [],
  activeCategory: 'all',
  activeStockFilter: 'all',
  activeSort: 'default',
  searchTerm: '',
  visibleProductCount: 24,
  productPageSize: 24,
  searchTimer: null,
  siteInfo: {},
  msbPaymentEnabled: false,
  selectedBuyProduct: null,
  buyQuantity: 1,
  activeMsbCheckout: loadStoredMsbCheckout(),
  msbPollInterval: null,
  lastDeliveredItems: [],
  pendingPurchaseKey: null
};

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  store.init();
});

// ==========================================
// 1. STOREFRONT CONTROLLER
// ==========================================
const store = {
  async init() {
    this.initTheme();
    this.bindGlobalEvents();
    await this.fetchSiteInfo();

    // Check token or modal query param for deep-linking & preview
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get('token');
    if (tokenParam) {
      state.token = tokenParam;
      localStorage.setItem('shop_token', tokenParam);
    }

    // If saved token exists, fetch user profile
    if (state.token) {
      await this.fetchUserProfile();
    } else {
      this.updateAuthUI();
    }

    await this.loadProducts();
    const modalParam = urlParams.get('modal') || window.location.hash.replace('#', '');
    if ((modalParam === 'payment' || modalParam === 'deposit') && state.activeMsbCheckout) {
      this.displayMsbCheckout(state.activeMsbCheckout);
    } else if (modalParam === 'auth' || modalParam === 'login') {
      this.openAuthModal('login');
    } else if (modalParam === 'register') {
      this.openAuthModal('register');
    } else if (modalParam === 'buy' && state.products.length > 0) {
      this.openBuyModal(state.products[0].id);
    } else if (modalParam === 'detail' && state.products.length > 0) {
      this.openDetailModal(state.products[0].id);
    }

    // Auto-refresh products cache periodically (every 45s)
    setInterval(() => {
      this.loadProducts(false, true);
    }, 45000);
  },

  bindGlobalEvents() {
    // Search input with debounce
    const searchInput = document.getElementById('search-products-input');
    const searchClear = document.getElementById('search-clear-btn');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchTerm = e.target.value.trim().toLowerCase();
        state.visibleProductCount = state.productPageSize;
        if (searchClear) searchClear.style.display = state.searchTerm ? 'block' : 'none';
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => this.renderProducts(), 120);
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        state.searchTerm = '';
        state.visibleProductCount = state.productPageSize;
        searchClear.style.display = 'none';
        this.renderProducts();
      });
    }

    // Modal Close buttons
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.closeAllModals();
      });
    });

    // Close modal on click backdrop
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          this.closeAllModals();
        }
      });
    });

  },

  // Theme Management (Dark / Light)
  initTheme() {
    const saved = localStorage.getItem('shop_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    this.updateThemeIcons(saved);
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('shop_theme', next);
    this.updateThemeIcons(next);
  },

  updateThemeIcons(theme) {
    const sun = document.querySelector('.sun-icon');
    const moon = document.querySelector('.moon-icon');
    if (sun && moon) {
      if (theme === 'light') {
        sun.style.display = 'none';
        moon.style.display = 'block';
      } else {
        sun.style.display = 'block';
        moon.style.display = 'none';
      }
    }
  },

  // Auth Header helper
  getAuthHeaders(custom = {}) {
    const headers = { ...custom };
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    return headers;
  },

  // Fetch Site Announcement & Info
  async fetchSiteInfo() {
    try {
      const res = await fetch('/api/shop/info');
      const data = await res.json();
      if (data.success) {
        state.siteInfo = data;
        state.msbPaymentEnabled = Boolean(data.vietqr_payment_enabled || data.msb_payment_enabled || data.payos_payment_enabled);
        if (data.site_title) {
          document.getElementById('site-title-display').innerText = data.site_title;
        }
        if (data.announcement) {
          document.getElementById('announcement-text').innerText = data.announcement;
        }
      }
    } catch (e) {
      console.warn('Lỗi lấy thông tin shop:', e);
    }
  },

  // Fetch User Profile
  async fetchUserProfile() {
    try {
      const res = await fetch('/api/auth/me', {
        headers: this.getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        state.user = data.user;
        this.updateAuthUI();
      } else {
        // Token expired
        this.logout(false);
      }
    } catch (err) {
      this.updateAuthUI();
    }
  },

  // Update Auth UI Elements
  updateAuthUI() {
    const guestSection = document.getElementById('auth-guest-section');
    const userSection = document.getElementById('auth-user-section');
    const adminBtn = document.getElementById('btn-admin-panel-switch');
    const displayName = document.getElementById('user-display-name');
    const avatarText = document.getElementById('user-avatar-text');
    const roleBadge = document.getElementById('user-role-badge');

    if (state.user) {
      if (guestSection) guestSection.style.display = 'none';
      if (userSection) userSection.style.display = 'flex';

      if (displayName) displayName.innerText = state.user.username;
      if (avatarText) avatarText.innerText = (state.user.username || 'U').charAt(0).toUpperCase();
      if (roleBadge) {
        roleBadge.innerText = state.user.role === 'admin' ? 'Quản trị' : 'Khách hàng';
        roleBadge.className = `user-role-badge ${state.user.role === 'admin' ? 'role-admin' : 'role-customer'}`;
      }

      // Show admin button if role is admin
      if (adminBtn) {
        adminBtn.style.display = state.user.role === 'admin' ? 'inline-flex' : 'none';
      }
    } else {
      if (guestSection) guestSection.style.display = 'flex';
      if (userSection) userSection.style.display = 'none';
      if (adminBtn) adminBtn.style.display = 'none';
    }
  },

  // Load Products Catalog
  async loadProducts(force = false, silent = false) {
    try {
      const res = await fetch(`/api/shop/products${force ? '?refresh=true' : ''}`);
      const data = await res.json();

      if (data.success && Array.isArray(data.products)) {
        state.products = data.products;
        if (force) state.visibleProductCount = state.productPageSize;
        this.updateCategoryCounters();
        this.renderProducts();
      }
    } catch (err) {
      if (!silent) this.showToast('Không thể tải danh sách sản phẩm', 'error');
    }
  },

  // Update Category Badge Counters
  updateCategoryCounters() {
    const all = state.products.length;
    const ai = state.products.filter(p => p.category === 'ai').length;
    const design = state.products.filter(p => p.category === 'design').length;
    const office = state.products.filter(p => p.category === 'office').length;
    const edu = state.products.filter(p => p.category === 'edu').length;
    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.innerText = value;
    };

    setText('cat-count-all', all);
    setText('cat-count-ai', ai);
    setText('cat-count-design', design);
    setText('cat-count-office', office);
    setText('cat-count-edu', edu);

    const inStockCategories = state.products.filter(p => p.stock > 0).length;
    const totalUnitsInStock = state.products.reduce((sum, p) => sum + (p.stock || 0), 0);
    setText('stock-count-all', all);
    setText('stock-count-in', inStockCategories);
    setText('hero-product-total', all.toLocaleString('vi-VN'));
    setText('hero-stock-total', totalUnitsInStock.toLocaleString('vi-VN'));
  },

  // Filter & Sort Products
  getFilteredProducts() {
    let list = [...state.products];

    // Category filter
    if (state.activeCategory !== 'all') {
      list = list.filter(p => p.category === state.activeCategory);
    }

    // Stock filter
    if (state.activeStockFilter === 'in_stock') {
      list = list.filter(p => p.stock > 0);
    }

    // Search query
    if (state.searchTerm) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(state.searchTerm) ||
        (p.description && p.description.toLowerCase().includes(state.searchTerm))
      );
    }

    // Sort
    switch (state.activeSort) {
      case 'price-asc':
        list.sort((a, b) => a.price_vnd - b.price_vnd);
        break;
      case 'price-desc':
        list.sort((a, b) => b.price_vnd - a.price_vnd);
        break;
      case 'stock-desc':
        list.sort((a, b) => b.stock - a.stock);
        break;
      default:
        // Prioritize in-stock products, then keep the curated storefront order.
        const featuredOrder = new Map([
          ['link gemini pro 18m', 0],
          ['capcut pro team 1m (fw)', 1],
          ['capcut pro 7d (fw)', 2]
        ]);
        list.sort((a, b) => {
          if (a.stock > 0 && b.stock <= 0) return -1;
          if (a.stock <= 0 && b.stock > 0) return 1;
          return (featuredOrder.get(a.name.toLowerCase()) ?? 99) - (featuredOrder.get(b.name.toLowerCase()) ?? 99);
        });
        break;
    }

    return list;
  },

  renderProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty-state');
    const loadMore = document.getElementById('products-load-more');
    const resultCount = document.getElementById('products-result-count');
    const filtered = this.getFilteredProducts();

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      loadMore.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    const visibleProducts = filtered.slice(0, state.visibleProductCount);

    grid.innerHTML = visibleProducts.map(product => {
      const isOutOfStock = product.stock <= 0;
      const stockBadge = isOutOfStock
        ? `<span class="stock-badge stock-out">Tạm hết hàng</span>`
        : `<span class="stock-badge stock-in"><i aria-hidden="true"></i>Còn ${product.stock} gói</span>`;

      const visual = this.getProductVisual(product);
      const snippet = visual.description.slice(0, 112);

      return `
        <article class="product-card product-card-${visual.tone} ${isOutOfStock ? 'out-of-stock' : ''}">
          <div class="product-media">
            <img src="${visual.image}" alt="Minh họa ${this.escapeHtml(product.name)}" width="1200" height="900" decoding="async">
            <span class="product-duration">${visual.label}</span>
          </div>
          <div class="product-card-body">
            <span class="product-eyebrow">${visual.eyebrow}</span>
            <div class="product-top">
              <h3 class="product-name" title="${this.escapeHtml(product.name)}">${this.escapeHtml(product.name)}</h3>
              ${stockBadge}
            </div>
            <p class="product-description-snippet">${this.escapeHtml(snippet)}${snippet.length >= 112 ? '…' : ''}</p>

            <div class="product-benefits" aria-label="Quyền lợi">
              <span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Giao tự động</span>
              <span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>Kho realtime</span>
            </div>

            <div class="product-price-section">
              <div class="price-label-wrap">
                <small>Giá thanh toán</small>
                <span class="price-vnd">${this.formatVnd(product.price_vnd)}</span>
              </div>
              <span class="price-currency-badge">VNĐ</span>
            </div>

            <div class="product-actions">
              <button class="btn btn-secondary btn-sm" onclick="store.openDetailModal(${product.id})">
                Chi tiết
              </button>
              <button class="btn btn-primary btn-sm ${isOutOfStock ? 'disabled' : ''}"
                      ${isOutOfStock ? 'disabled' : ''}
                      onclick="store.openBuyModal(${product.id})">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                  <line x1="3" y1="6" x2="21" y2="6"/>
                </svg>
                Mua ngay
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    const hasMore = visibleProducts.length < filtered.length;
    loadMore.style.display = hasMore ? 'flex' : 'none';
    loadMore.querySelector('button').style.display = hasMore ? 'inline-flex' : 'none';
    resultCount.innerText = `Đang hiển thị ${visibleProducts.length} / ${filtered.length} sản phẩm`;
  },

  initSpatial3DTilt() {
    // Disabled as requested (bỏ effect cursor khi trỏ)
  },

  getProductVisual(product) {
    const name = (product.name || '').toLowerCase();
    if (name === 'link gemini pro 18m') {
      return {
        image: 'images/products/gemini-pro-18m.webp',
        label: 'AI · 18 tháng',
        eyebrow: 'Gói dài hạn',
        description: 'Gói AI dài hạn qua link kích hoạt, phù hợp cho học tập và công việc hằng ngày.',
        tone: 'gemini'
      };
    }
    if (name === 'capcut pro team 1m (fw)') {
      return {
        image: 'images/products/capcut-pro-team-1m.webp',
        label: 'Team · 1 tháng',
        eyebrow: 'Dành cho đội nhóm',
        description: 'Gói CapCut Pro Team 1 tháng dành cho cộng tác và chỉnh sửa video trên nhiều thiết bị.',
        tone: 'team'
      };
    }
    return {
      image: 'images/products/capcut-pro-7d.webp',
      label: 'Cá nhân · 7 ngày',
      eyebrow: 'Gói trải nghiệm',
      description: 'Gói CapCut Pro 7 ngày để trải nghiệm nhanh các tính năng chỉnh sửa video nâng cao.',
      tone: 'weekly'
    };
  },

  loadMoreProducts() {
    state.visibleProductCount += state.productPageSize;
    this.renderProducts();
  },

  filterCategory(cat) {
    state.activeCategory = cat;
    state.visibleProductCount = state.productPageSize;
    document.querySelectorAll('.category-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === cat);
    });
    this.renderProducts();
  },

  filterStock(filter) {
    state.activeStockFilter = filter;
    state.visibleProductCount = state.productPageSize;
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.stock === filter);
    });
    this.renderProducts();
  },

  changeSort(sortVal) {
    state.activeSort = sortVal;
    state.visibleProductCount = state.productPageSize;
    this.renderProducts();
  },

  resetFilters() {
    state.activeCategory = 'all';
    state.activeStockFilter = 'all';
    state.activeSort = 'default';
    state.searchTerm = '';
    state.visibleProductCount = state.productPageSize;
    const searchInput = document.getElementById('search-products-input');
    if (searchInput) searchInput.value = '';
    this.filterCategory('all');
  },

  // ==========================================
  // AUTHENTICATION LOGIC (LOGIN / REGISTER)
  // ==========================================
  openAuthModal(tab = 'login') {
    this.switchAuthTab(tab);
    const alertBox = document.getElementById('auth-inline-alert');
    if (alertBox) alertBox.style.display = 'none';
    this.openModal('modal-auth');
    setTimeout(() => {
      const activeInput = tab === 'login'
        ? document.getElementById('login-username')
        : document.getElementById('register-username');
      if (activeInput) activeInput.focus();
    }, 80);
  },

  switchAuthTab(tab) {
    const loginForm = document.getElementById('form-login');
    const regForm = document.getElementById('form-register');
    const tabLoginBtn = document.getElementById('tab-btn-login');
    const tabRegBtn = document.getElementById('tab-btn-register');
    const title = document.getElementById('auth-modal-title');
    const subtitle = document.getElementById('auth-modal-subtitle');
    const alertBox = document.getElementById('auth-inline-alert');
    if (alertBox) alertBox.style.display = 'none';

    if (tab === 'login') {
      if (loginForm) loginForm.style.display = 'block';
      if (regForm) regForm.style.display = 'none';
      if (tabLoginBtn) {
        tabLoginBtn.classList.add('active');
        tabLoginBtn.setAttribute('aria-selected', 'true');
      }
      if (tabRegBtn) {
        tabRegBtn.classList.remove('active');
        tabRegBtn.setAttribute('aria-selected', 'false');
      }
      if (title) title.innerText = 'Chào mừng trở lại!';
      if (subtitle) subtitle.innerText = 'Đăng nhập tài khoản để nhận sản phẩm tức thì';
    } else {
      if (loginForm) loginForm.style.display = 'none';
      if (regForm) regForm.style.display = 'block';
      if (tabLoginBtn) {
        tabLoginBtn.classList.remove('active');
        tabLoginBtn.setAttribute('aria-selected', 'false');
      }
      if (tabRegBtn) {
        tabRegBtn.classList.add('active');
        tabRegBtn.setAttribute('aria-selected', 'true');
      }
      if (title) title.innerText = 'Tạo tài khoản mới';
      if (subtitle) subtitle.innerText = 'Trải nghiệm mua sắm bảo mật, lịch sử đơn hàng tự động';
    }
  },

  fillDemoAccount(username, password) {
    this.switchAuthTab('login');
    const u = document.getElementById('login-username');
    const p = document.getElementById('login-password');
    if (u) {
      u.value = username;
      u.focus();
    }
    if (p) {
      p.value = password;
    }
    const alertBox = document.getElementById('auth-inline-alert');
    if (alertBox) {
      alertBox.className = 'auth-inline-alert alert-info';
      alertBox.innerHTML = `Đã tự động điền tài khoản mẫu: <strong>${this.escapeHtml(username)}</strong>. Bấm "Đăng nhập ngay" để tiếp tục.`;
      alertBox.style.display = 'flex';
    }
  },

  togglePasswordVisibility(inputId, toggleBtn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-label', isPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      toggleBtn.innerHTML = isPassword
        ? `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>`
        : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    }
  },

  async handleLogin(e) {
    e.preventDefault();
    const alertBox = document.getElementById('auth-inline-alert');
    if (alertBox) alertBox.style.display = 'none';

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    const btn = document.getElementById('btn-submit-login');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> Đang đăng nhập...`;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('shop_token', data.token);

        this.closeAllModals();
        this.updateAuthUI();
        this.showToast(`Chào mừng ${data.user.username} đã đăng nhập thành công!`, 'success');
      } else {
        const errorMsg = data.error || 'Tên tài khoản hoặc mật khẩu không chính xác.';
        if (alertBox) {
          alertBox.className = 'auth-inline-alert alert-error';
          alertBox.innerText = errorMsg;
          alertBox.style.display = 'flex';
        }
        this.showToast(errorMsg, 'error');
      }
    } catch (err) {
      if (alertBox) {
        alertBox.className = 'auth-inline-alert alert-error';
        alertBox.innerText = 'Lỗi kết nối máy chủ. Vui lòng kiểm tra lại mạng.';
        alertBox.style.display = 'flex';
      }
      this.showToast('Lỗi kết nối máy chủ', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  },

  async handleRegister(e) {
    e.preventDefault();
    const alertBox = document.getElementById('auth-inline-alert');
    if (alertBox) alertBox.style.display = 'none';

    const username = document.getElementById('register-username').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;

    const btn = document.getElementById('btn-submit-register');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> Đang tạo tài khoản...`;

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('shop_token', data.token);

        this.closeAllModals();
        this.updateAuthUI();
        this.showToast(`Tạo tài khoản thành công! Chào mừng ${data.user.username}.`, 'success');
      } else {
        const errorMsg = data.error || 'Đăng ký thất bại. Vui lòng thử lại.';
        if (alertBox) {
          alertBox.className = 'auth-inline-alert alert-error';
          alertBox.innerText = errorMsg;
          alertBox.style.display = 'flex';
        }
        this.showToast(errorMsg, 'error');
      }
    } catch (err) {
      if (alertBox) {
        alertBox.className = 'auth-inline-alert alert-error';
        alertBox.innerText = 'Lỗi kết nối máy chủ. Vui lòng thử lại sau.';
        alertBox.style.display = 'flex';
      }
      this.showToast('Lỗi kết nối máy chủ', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  },

  logout(showToast = true) {
    this.clearMsbPoll();
    state.activeMsbCheckout = null;
    localStorage.removeItem('shop_active_msb_checkout');
    state.token = '';
    state.user = null;
    localStorage.removeItem('shop_token');
    this.updateAuthUI();
    if (showToast) this.showToast('Đã đăng xuất tài khoản thành công.', 'info');
  },

  // ==========================================
  // PURCHASE FLOW (BUY & DETAIL MODALS)
  // ==========================================
  openDetailModal(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) return;

    const visual = this.getProductVisual(product);

    const title = document.getElementById('modal-detail-title');
    if (title) title.innerText = product.name;

    const eyebrow = document.getElementById('modal-detail-eyebrow');
    if (eyebrow) eyebrow.innerText = visual.eyebrow || 'Gói công cụ số';

    const pill = document.getElementById('modal-detail-pill');
    if (pill) pill.innerText = visual.label || 'Tự động 24/7';

    const img = document.getElementById('modal-detail-img');
    if (img) {
      img.src = visual.image;
      img.alt = product.name;
    }

    const stockChip = document.getElementById('modal-detail-stock-chip');
    if (stockChip) {
      stockChip.innerText = product.stock > 0 ? `🟢 Còn ${product.stock} gói` : '🔴 Tạm hết hàng';
      stockChip.className = `detail-stock-chip ${product.stock > 0 ? 'stock-in' : 'stock-out'}`;
    }

    const vndEl = document.getElementById('modal-detail-vnd');
    if (vndEl) vndEl.innerText = this.formatVnd(product.price_vnd);

    const usdtEl = document.getElementById('modal-detail-usdt');
    if (usdtEl) {
      const priceUsdt = product.price_usdt || (product.price_vnd / (state.usdtRate || 25000));
      usdtEl.innerText = `${priceUsdt.toFixed(2)} USDT`;
    }

    const stockEl = document.getElementById('modal-detail-stock');
    if (stockEl) stockEl.innerText = product.stock > 0 ? `${product.stock} gói` : 'Hết hàng';

    const descBox = document.getElementById('modal-detail-desc');
    if (descBox) {
      const raw = product.description || visual.description || 'Không có mô tả bổ sung.';
      descBox.innerHTML = raw
        .split('\n')
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed) return '<br>';
          if (trimmed.startsWith('-') || trimmed.startsWith('+') || trimmed.startsWith('•')) {
            return `<div class="desc-bullet"><span class="bullet-dot">•</span> <span>${this.escapeHtml(trimmed.replace(/^[-+•]\s*/, ''))}</span></div>`;
          }
          if (trimmed.includes(':')) {
            const [k, ...rest] = trimmed.split(':');
            return `<div class="desc-row"><strong class="desc-k">${this.escapeHtml(k)}:</strong> <span class="desc-v">${this.escapeHtml(rest.join(':'))}</span></div>`;
          }
          return `<p class="desc-p">${this.escapeHtml(trimmed)}</p>`;
        })
        .join('');
    }

    const btnBuy = document.getElementById('btn-modal-detail-buy');
    if (btnBuy) {
      btnBuy.disabled = product.stock <= 0;
      btnBuy.onclick = () => {
        this.closeAllModals();
        this.openBuyModal(productId);
      };
    }

    this.openModal('modal-prod-detail');
  },

  copyDetailDesc() {
    const descBox = document.getElementById('modal-detail-desc');
    if (!descBox) return;
    const text = descBox.innerText;
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('Đã sao chép hướng dẫn sử dụng!', 'success');
    }).catch(() => {
      this.showToast('Chưa thể sao chép văn bản', 'error');
    });
  },

  openBuyModal(productId) {
    if (!state.user) {
      this.showToast('Vui lòng đăng nhập trước khi mua hàng!', 'info');
      this.openAuthModal('login');
      return;
    }

    const product = state.products.find(p => p.id === productId);
    if (!product || product.stock <= 0) {
      this.showToast('Sản phẩm này tạm thời hết hàng!', 'error');
      return;
    }

    state.selectedBuyProduct = product;
    state.buyQuantity = 1;
    state.pendingPurchaseKey = null;

    document.getElementById('buy-prod-name').innerText = product.name;
    document.getElementById('buy-prod-stock').innerText = product.stock;
    document.getElementById('buy-qty-val').value = 1;
    document.getElementById('buy-qty-val').max = Math.min(product.stock, 100);

    this.updateBuyTotal();
    this.openModal('modal-buy');
  },

  adjustBuyQty(delta) {
    if (!state.selectedBuyProduct) return;
    const input = document.getElementById('buy-qty-val');
    let val = parseInt(input.value, 10) || 1;
    val += delta;
    if (val < 1) val = 1;
    if (val > Math.min(state.selectedBuyProduct.stock, 100)) val = Math.min(state.selectedBuyProduct.stock, 100);
    input.value = val;
    this.updateBuyTotal();
  },

  updateBuyTotal() {
    if (!state.selectedBuyProduct || !state.user) return;
    const product = state.selectedBuyProduct;
    const qtyInput = document.getElementById('buy-qty-val');
    let qty = parseInt(qtyInput.value, 10) || 1;
    if (qty < 1) qty = 1;
    if (qty > Math.min(product.stock, 100)) qty = Math.min(product.stock, 100);
    qtyInput.value = qty;
    state.buyQuantity = qty;

    const totalVnd = product.price_vnd * qty;
    document.getElementById('opt-total-vnd').innerText = `Tổng: ${this.formatVnd(totalVnd)}`;
    const alertEl = document.getElementById('buy-payment-unavailable');
    const submitBtn = document.getElementById('btn-submit-buy');
    if (!state.msbPaymentEnabled) {
      alertEl.style.display = 'flex';
      submitBtn.disabled = true;
    } else {
      alertEl.style.display = 'none';
      submitBtn.disabled = false;
    }
  },

  async handleConfirmBuy(e) {
    e.preventDefault();
    if (!state.selectedBuyProduct) return;

    const submitBtn = document.getElementById('btn-submit-buy');
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Đang tạo mã VietQR...';
    if (!state.pendingPurchaseKey) {
      state.pendingPurchaseKey = window.crypto?.randomUUID?.() || `buy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    try {
      const res = await fetch('/api/shop/checkout/vietqr', {
        method: 'POST',
        headers: this.getAuthHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': state.pendingPurchaseKey
        }),
        body: JSON.stringify({
          product_id: state.selectedBuyProduct.id,
          quantity: state.buyQuantity
        })
      });

      const data = await res.json();
      state.pendingPurchaseKey = null;

      if (res.ok && data.success && data.checkout) {
        this.closeAllModals();
        this.displayMsbCheckout(data.checkout);
      } else {
        this.showToast(data.error || 'Giao dịch thất bại. Vui lòng kiểm tra lại.', 'error');
      }
    } catch (err) {
      this.showToast('Mất kết nối khi tạo QR. Bạn có thể bấm lại, hệ thống sẽ không tạo trùng đơn.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
          <line x1="3" y1="6" x2="21" y2="6"/>
        </svg>
        Tạo mã VietQR
      `;
    }
  },

  showDeliveryModal(productName, items) {
    state.lastDeliveredItems = items;
    document.getElementById('delivery-prod-title').innerText = `Sản phẩm: ${productName}`;
    document.getElementById('delivery-items-count').innerText = items.length;

    const listEl = document.getElementById('delivery-items-list');
    listEl.innerHTML = items.map(item => `
      <div class="item-row">
        <span class="item-code">${this.escapeHtml(item)}</span>
        <button class="btn btn-xs btn-outline" onclick="store.copyText('${this.escapeJs(item)}', 'Đã sao chép tài khoản!')">
          Sao chép
        </button>
      </div>
    `).join('');

    this.openModal('modal-delivery');
  },

  copyAllDeliveryItems() {
    if (state.lastDeliveredItems && state.lastDeliveredItems.length > 0) {
      this.copyText(state.lastDeliveredItems.join('\n'), 'Đã sao chép tất cả tài khoản!');
    }
  },

  displayMsbCheckout(checkout) {
    this.clearMsbPoll();
    state.activeMsbCheckout = checkout;
    localStorage.setItem('shop_active_msb_checkout', JSON.stringify(checkout));
    const activePaymentBtn = document.getElementById('btn-active-payment');
    if (activePaymentBtn) activePaymentBtn.style.display = 'inline-flex';

    document.getElementById('msb-qr-image').src = checkout.qr_url;
    document.getElementById('msb-transfer-content').innerText = checkout.transfer_content || checkout.code;
    document.getElementById('msb-account-number').innerText = checkout.bank_account_number || '---';
    document.getElementById('msb-account-name').innerText = `${checkout.bank_account_name || ''} · ${checkout.bank_name || 'VietQR'}`;

    // Amount (main + copy in info column)
    const amountEl = document.getElementById('msb-payment-amount');
    amountEl.innerText = this.formatVnd(checkout.amount_vnd);
    amountEl.dataset.raw = String(checkout.amount_vnd);
    const amountCopy = document.getElementById('msb-payment-amount-copy');
    if (amountCopy) {
      amountCopy.innerText = this.formatVnd(checkout.amount_vnd);
      amountCopy.dataset.raw = String(checkout.amount_vnd);
    }

    // Product name in header
    const prodName = document.getElementById('payment-product-name');
    if (prodName) prodName.innerText = checkout.product_name || `Đơn hàng ${checkout.code}`;

    document.getElementById('msb-expiry-hint').innerText = `Đơn có hiệu lực đến ${this.formatDate(checkout.expires_at)}.`;

    // Show/hide cancel button based on status
    const cancelBtn = document.getElementById('btn-cancel-payment');
    if (cancelBtn) cancelBtn.style.display = (checkout.status === 'pending') ? 'inline-flex' : 'none';

    this.updateMsbPaymentStatus(checkout);
    this.openModal('modal-payment');

    if (checkout.status === 'pending' || checkout.status === 'processing') this.startMsbPoll();
  },

  openActivePayment() {
    if (!state.activeMsbCheckout) return;
    this.displayMsbCheckout(state.activeMsbCheckout);
    this.checkMsbPayment(false);
  },

  updateMsbPaymentStatus(checkout) {
    const badge = document.getElementById('msb-status-badge');
    const label = document.getElementById('msb-status-label');
    const statuses = {
      pending: ['payment-status-bar', 'Đang chờ ngân hàng xác nhận thanh toán...'],
      processing: ['payment-status-bar status-confirmed', 'Đã nhận tiền, đang lấy sản phẩm...'],
      delivered: ['payment-status-bar status-confirmed', 'Thanh toán thành công, sản phẩm đã sẵn sàng'],
      expired: ['payment-status-bar status-failed', 'Đơn đã hết hạn thanh toán'],
      cancelled: ['payment-status-bar status-failed', 'Đơn đã được hủy bởi khách hàng'],
      amount_mismatch: ['payment-status-bar status-failed', 'Số tiền chuyển khoản không khớp'],
      paid_late: ['payment-status-bar status-failed', 'Thanh toán sau khi đơn hết hạn'],
      paid_pending_delivery: ['payment-status-bar status-failed', 'Đã nhận tiền, đang chờ xử lý giao hàng']
    };
    const view = statuses[checkout.status] || statuses.pending;
    badge.className = view[0];
    label.innerText = view[1];
  },

  async cancelPayment() {
    if (!state.activeMsbCheckout?.code) return;

    const confirmed = confirm('Bạn có chắc chắn muốn hủy đơn thanh toán này?\n\nNếu bạn đã chuyển tiền, vui lòng KHÔNG hủy và chờ hệ thống xác nhận.');
    if (!confirmed) return;

    const cancelBtn = document.getElementById('btn-cancel-payment');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.innerHTML = '<span class="btn-spinner"></span> Đang hủy...';
    }

    try {
      const res = await fetch('/api/shop/checkout/cancel', {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code: state.activeMsbCheckout.code })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.clearMsbPoll();
        state.activeMsbCheckout = null;
        localStorage.removeItem('shop_active_msb_checkout');
        const activePaymentBtn = document.getElementById('btn-active-payment');
        if (activePaymentBtn) activePaymentBtn.style.display = 'none';
        this.closeAllModals();
        this.showToast('Đơn thanh toán đã được hủy thành công.', 'info');
      } else {
        this.showToast(data.error || 'Không thể hủy đơn thanh toán', 'error');
      }
    } catch (err) {
      this.showToast('Lỗi kết nối máy chủ khi hủy đơn', 'error');
    } finally {
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg> Hủy đơn thanh toán';
      }
    }
  },

  startMsbPoll() {
    this.clearMsbPoll();
    state.msbPollInterval = setInterval(() => this.checkMsbPayment(false), 10000);
  },

  async checkMsbPayment(manual = false) {
    if (!state.activeMsbCheckout?.code) return;
    const button = document.getElementById('btn-msb-check');
    if (manual && button) {
      button.disabled = true;
      button.innerText = 'Đang kiểm tra...';
    }

    try {
      const code = state.activeMsbCheckout.code;
      let res;
      if (manual) {
        res = await fetch('/api/shop/checkout/vietqr/check', {
          method: 'POST',
          headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ code })
        });
      } else {
        res = await fetch(`/api/shop/checkout/vietqr/status?code=${encodeURIComponent(code)}`, {
          headers: this.getAuthHeaders()
        });
      }
      const data = await res.json();
      if (!res.ok || !data.success || !data.checkout) {
        if (manual) this.showToast(data.error || 'Chưa thể kiểm tra giao dịch', 'error');
        return;
      }

      const checkout = data.checkout;
      state.activeMsbCheckout = checkout;
      localStorage.setItem('shop_active_msb_checkout', JSON.stringify(checkout));
      this.updateMsbPaymentStatus(checkout);

      if (checkout.status === 'delivered') {
        this.clearMsbPoll();
        state.activeMsbCheckout = null;
        localStorage.removeItem('shop_active_msb_checkout');
        const activePaymentBtn = document.getElementById('btn-active-payment');
        if (activePaymentBtn) activePaymentBtn.style.display = 'none';
        this.showToast('Thanh toán thành công! Sản phẩm đã sẵn sàng.', 'success');
        this.closeAllModals();
        this.showDeliveryModal(checkout.product_name, checkout.items || []);
        this.loadProducts(true, true);
      } else if (['expired', 'amount_mismatch', 'paid_late', 'paid_pending_delivery'].includes(checkout.status)) {
        this.clearMsbPoll();
        if (manual) this.showToast(checkout.error || 'Đơn cần quản trị viên kiểm tra', 'error');
      } else if (manual) {
        this.showToast('Hệ thống chưa nhận được thanh toán từ ngân hàng. Vẫn đang tự động kiểm tra.', 'info');
      }
    } catch (error) {
      if (manual) this.showToast('Không thể kết nối để kiểm tra. Vui lòng thử lại sau.', 'error');
    } finally {
      if (manual && button) {
        button.disabled = false;
        button.innerText = 'Kiểm tra ngay';
      }
    }
  },

  clearMsbPoll() {
    if (state.msbPollInterval) clearInterval(state.msbPollInterval);
    state.msbPollInterval = null;
  },

  // ==========================================
  // CUSTOMER ORDERS HISTORY & ADMIN
  // ==========================================
  openAdminModal() {
    if (typeof admin !== 'undefined' && admin.openAdminModal) {
      admin.openAdminModal();
    }
  },

  async openOrdersModal() {
    if (!state.user) {
      this.openAuthModal('login');
      return;
    }

    this.openModal('modal-orders');
    await this.loadMyOrders();
  },

  async loadMyOrders() {
    const tbody = document.getElementById('my-orders-tbody');
    try {
      const res = await fetch('/api/shop/orders', {
        headers: this.getAuthHeaders()
      });
      const data = await res.json();

      if (data.success && data.orders) {
        if (data.orders.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4">Bạn chưa có đơn hàng nào.</td></tr>';
          return;
        }

        tbody.innerHTML = data.orders.map(o => {
          const displayCode = o.checkout_code || (o.id ? `#${o.id}` : `DH${o.checkout_id}`);
          const isSuccess = o.status === 'completed' || o.status === 'delivered';
          const isPaidPending = o.status === 'paid_pending_delivery';
          const isPending = o.status === 'pending' || o.status === 'processing';
          const isExpired = o.status === 'expired';

          let statusBadge = '';
          let dataActionCell = '';

          if (isSuccess) {
            statusBadge = '<span class="badge-status badge-success">✓ Hoàn tất</span>';
            const itemsText = (o.items && o.items.length > 0) ? o.items.join('\n') : '---';
            const itemsPreview = (o.items && o.items.length > 0) ? o.items[0] : '---';
            dataActionCell = `
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="item-code" style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${store.escapeHtml(itemsPreview)}">
                  ${store.escapeHtml(itemsPreview)}
                </span>
                <button class="btn btn-xs btn-outline" onclick="store.copyText('${store.escapeJs(itemsText)}', 'Đã sao chép tài khoản!')">
                  Sao chép (${o.items ? o.items.length : 0})
                </button>
              </div>
            `;
          } else if (isPaidPending) {
            statusBadge = '<span class="badge-status badge-warning">⏳ Đã thanh toán (Đang cấp hàng)</span>';
            dataActionCell = `
              <div style="font-size:0.75rem; color:#fbbf24; line-height:1.4;">
                <span>Đã nhận tiền thành công. Hệ thống đang tự động lấy tài khoản từ kho...</span>
              </div>
            `;
          } else if (isPending) {
            statusBadge = '<span class="badge-status badge-info">💳 Chờ chuyển khoản</span>';
            dataActionCell = `
              <button class="btn btn-xs btn-primary" onclick="store.reopenCheckout('${store.escapeJs(o.checkout_code || '')}')">
                Xem mã QR thanh toán
              </button>
            `;
          } else if (isExpired) {
            statusBadge = '<span class="badge-status badge-danger">Hết hạn</span>';
            dataActionCell = '<span class="text-muted" style="font-size:0.75rem;">Đơn đã hết hạn thanh toán</span>';
          } else {
            statusBadge = `<span class="badge-status badge-danger">${store.escapeHtml(o.status)}</span>`;
            dataActionCell = `<span class="text-rose" style="font-size:0.75rem;">${store.escapeHtml(o.checkout_error || 'Cần hỗ trợ')}</span>`;
          }

          return `
            <tr>
              <td><code class="item-code">${store.escapeHtml(displayCode)}</code></td>
              <td>${store.formatDate(o.created_at)}</td>
              <td><strong>${store.escapeHtml(o.product_name)}</strong></td>
              <td>${o.quantity}</td>
              <td>
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <strong class="text-emerald">${store.formatVnd(o.price_paid)}</strong>
                  ${statusBadge}
                </div>
              </td>
              <td>${dataActionCell}</td>
            </tr>
          `;
        }).join('');
      }
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-rose py-4">Lỗi tải danh sách đơn hàng.</td></tr>';
    }
  },

  async reopenCheckout(code) {
    if (!code) return;
    try {
      const res = await fetch(`/api/shop/checkout/vietqr/status?code=${encodeURIComponent(code)}`, {
        headers: this.getAuthHeaders()
      });
      const data = await res.json();
      if (data.success && data.checkout) {
        this.closeAllModals();
        this.displayMsbCheckout(data.checkout);
      } else {
        this.showToast(data.error || 'Không thể mở lại đơn thanh toán', 'error');
      }
    } catch (e) {
      this.showToast('Lỗi kết nối kiểm tra đơn', 'error');
    }
  },

  // Modal Control
  openModal(modalId) {
    this.closeAllModals();
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  },

  closeAllModals() {
    this.clearMsbPoll();
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.remove('open'));
    document.body.style.overflow = '';
  },

  // Copy helper
  copyText(text, successMsg = 'Đã sao chép!') {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast(successMsg, 'success');
      }).catch(() => {
        this.fallbackCopy(text, successMsg);
      });
    } else {
      this.fallbackCopy(text, successMsg);
    }
  },

  fallbackCopy(text, msg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      this.showToast(msg, 'success');
    } catch (e) {
      this.showToast('Không thể sao chép tự động', 'error');
    }
    document.body.removeChild(ta);
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
      error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>'
    };
    const icon = icons[type] || icons.info;

    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg></span>
      <span class="toast-msg">${this.escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  formatVnd(num) {
    return (num || 0).toLocaleString('vi-VN') + ' đ';
  },

  formatDate(dateStr) {
    if (!dateStr) return '---';
    try {
      let d;
      // SQLite returns 'YYYY-MM-DD HH:MM:SS' in UTC without timezone suffix
      if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dateStr)) {
        d = new Date(dateStr.replace(' ', 'T') + 'Z');
      } else {
        d = new Date(dateStr);
      }
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('vi-VN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return dateStr;
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },

  escapeJs(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
};

// ==========================================
// 2. ADMIN PANEL CONTROLLER
// ==========================================
const admin = {
  openAdminModal() {
    if (!state.user || state.user.role !== 'admin') {
      store.showToast('Bạn không có quyền truy cập trang quản trị', 'error');
      return;
    }

    this.switchTab('overview');
    store.openModal('modal-admin');
    this.loadStats();
  },

  switchTab(tab) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-pane').forEach(p => p.style.display = 'none');

    const targetBtn = Array.from(document.querySelectorAll('.admin-tab-btn')).find(b => b.getAttribute('onclick')?.includes(tab));
    const targetPane = document.getElementById(`admin-tab-${tab}`);

    if (targetBtn) targetBtn.classList.add('active');
    if (targetPane) targetPane.style.display = 'block';

    if (tab === 'overview') this.loadStats();
    if (tab === 'settings') this.loadSettings();
    if (tab === 'users') this.loadUsers();
    if (tab === 'orders') this.loadAllOrders();
  },

  async loadStats() {
    try {
      const res = await fetch('/api/admin/stats', {
        headers: store.getAuthHeaders()
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('admin-stat-users').innerText = data.stats.totalUsers;
        document.getElementById('admin-stat-orders').innerText = data.stats.totalOrders;
        document.getElementById('admin-stat-profit-vnd').innerText = store.formatVnd(data.stats.profit_vnd);

        if (data.supplier_balance) {
          document.getElementById('admin-sup-username').innerText = data.supplier_balance.username || 'haqfuong2075';
          document.getElementById('admin-sup-vnd').innerText = store.formatVnd(data.supplier_balance.balance_vnd);
        }
      }
    } catch (e) {
      console.warn('Lỗi tải thống kê admin:', e);
    }
  },

  async refreshSupplierBalance() {
    try {
      const res = await fetch('/api/admin/stats', { headers: store.getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.supplier_balance) {
        document.getElementById('admin-sup-vnd').innerText = store.formatVnd(data.supplier_balance.balance_vnd);
        store.showToast('Đã làm mới số dư tổng kho!', 'success');
      }
    } catch (e) {
      store.showToast('Không thể kết nối API tổng kho', 'error');
    }
  },

  async loadSettings() {
    try {
      const res = await fetch('/api/admin/settings', { headers: store.getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.settings) {
        const s = data.settings;
        document.getElementById('admin-set-markup').value = s.markup_percent || '15';
        document.getElementById('admin-set-announcement').value = s.site_announcement || '';
      }
    } catch (e) {
      console.warn('Lỗi tải cấu hình:', e);
    }
  },

  async saveSettings(e) {
    e.preventDefault();
    const markup_percent = document.getElementById('admin-set-markup').value;
    const site_announcement = document.getElementById('admin-set-announcement').value.trim();

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: store.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          markup_percent,
          site_announcement
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        store.showToast('Đã lưu cấu hình và cập nhật giá bán toàn shop!', 'success');
        await store.fetchSiteInfo();
        await store.loadProducts(true);
      } else {
        store.showToast(data.error || 'Lỗi lưu cấu hình', 'error');
      }
    } catch (err) {
      store.showToast('Lỗi mạng', 'error');
    }
  },

  async loadUsers() {
    const tbody = document.getElementById('admin-users-tbody');
    try {
      const res = await fetch('/api/admin/users', { headers: store.getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.users) {
        tbody.innerHTML = data.users.map(u => `
          <tr>
            <td>#${u.id}</td>
            <td><strong>${store.escapeHtml(u.username)}</strong></td>
            <td>${store.escapeHtml(u.email || '---')}</td>
            <td><strong class="text-emerald">${store.formatVnd(u.balance_vnd)}</strong></td>
            <td><span class="stock-badge ${u.role === 'admin' ? 'stock-in' : ''}">${u.role}</span></td>
            <td>
              <button class="btn btn-xs btn-outline" onclick="admin.promptAdjustBalance(${u.id}, '${store.escapeJs(u.username)}')">
                +/- Nạp ví
              </button>
            </td>
          </tr>
        `).join('');
      }
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4">Lỗi tải danh sách người dùng</td></tr>';
    }
  },

  promptAdjustBalance(userId, username) {
    const amountStr = prompt(`Nhập số tiền VNĐ muốn cộng/trừ cho [${username}] (ví dụ: 100000 hoặc -50000):`);
    if (!amountStr) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount === 0) {
      store.showToast('Số tiền không hợp lệ', 'error');
      return;
    }

    const note = prompt(`Nhập lý do điều chỉnh số dư:`, 'Admin điều chỉnh số dư thủ công');

    fetch('/api/admin/users/balance', {
      method: 'POST',
      headers: store.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        user_id: userId,
        delta_vnd: amount,
        note
      })
    }).then(r => r.json()).then(data => {
      if (data.success) {
        store.showToast(`Đã điều chỉnh ${store.formatVnd(amount)} cho ${username}!`, 'success');
        this.loadUsers();
        if (state.user && state.user.id === userId) {
          store.fetchUserProfile();
        }
      } else {
        store.showToast(data.error || 'Thất bại', 'error');
      }
    });
  },

  async loadAllOrders() {
    const tbody = document.getElementById('admin-all-orders-tbody');
    try {
      const res = await fetch('/api/admin/orders', { headers: store.getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.orders) {
        if (data.orders.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Chưa có đơn hàng nào được tạo.</td></tr>';
          return;
        }

        tbody.innerHTML = data.orders.map(o => {
          const displayCode = o.checkout_code || (o.id ? `#${o.id}` : `DH${o.checkout_id}`);
          const isSuccess = o.status === 'completed' || o.status === 'delivered';
          const isPaidPending = o.status === 'paid_pending_delivery';
          const isPending = o.status === 'pending' || o.status === 'processing';
          const isExpired = o.status === 'expired';

          let statusBadge = '';
          let actionButtons = '';

          if (isSuccess) {
            statusBadge = '<span class="badge-status badge-success">✓ Đã giao</span>';
            const itemsStr = (o.items && o.items.length > 0) ? o.items.join('\n') : '';
            if (itemsStr) {
              actionButtons = `
                <button class="btn btn-xs btn-outline" onclick="store.copyText('${store.escapeJs(itemsStr)}', 'Đã sao chép tài khoản!')">
                  Sao chép (${o.items.length})
                </button>
              `;
            } else {
              actionButtons = '<span class="text-muted" style="font-size:0.75rem;">Đã hoàn tất</span>';
            }
          } else if (isPaidPending) {
            statusBadge = `
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span class="badge-status badge-warning">⏳ Đã thanh toán (Kho thiếu vốn)</span>
                ${o.checkout_error ? `<span class="text-rose" style="font-size:0.7rem; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${store.escapeHtml(o.checkout_error)}">${store.escapeHtml(o.checkout_error)}</span>` : ''}
              </div>
            `;
            actionButtons = `
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn btn-xs btn-primary" onclick="admin.retryDelivery(${o.checkout_id})">
                  ⚡ Giao lại
                </button>
                <button class="btn btn-xs btn-outline" onclick="admin.promptManualDeliver(${o.checkout_id})">
                  Cấp tay
                </button>
              </div>
            `;
          } else if (isPending) {
            statusBadge = '<span class="badge-status badge-info">💳 Chờ khách CK</span>';
            actionButtons = '<span class="text-muted" style="font-size:0.75rem;">Đang chờ</span>';
          } else if (isExpired) {
            statusBadge = '<span class="badge-status badge-danger">Hết hạn</span>';
            actionButtons = '<span class="text-muted" style="font-size:0.75rem;">---</span>';
          } else {
            statusBadge = `<span class="badge-status badge-danger">${store.escapeHtml(o.status)}</span>`;
            actionButtons = `<button class="btn btn-xs btn-outline" onclick="admin.promptManualDeliver(${o.checkout_id})">Cấp tay</button>`;
          }

          return `
            <tr>
              <td><code class="item-code">${store.escapeHtml(displayCode)}</code></td>
              <td><strong>${store.escapeHtml(o.username || 'Khách')}</strong></td>
              <td>${store.escapeHtml(o.product_name)} <small class="text-muted">x${o.quantity}</small></td>
              <td><strong class="text-emerald">${store.formatVnd(o.price_paid)}</strong></td>
              <td><strong class="text-amber">${'+' + store.formatVnd(o.profit)}</strong></td>
              <td>${statusBadge}</td>
              <td style="font-size:0.78rem; color:var(--text-muted);">${store.formatDate(o.created_at)}</td>
              <td>${actionButtons}</td>
            </tr>
          `;
        }).join('');
      }
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Lỗi tải danh sách đơn hàng</td></tr>';
    }
  },

  async retryDelivery(checkoutId) {
    if (!confirm('Bạn có muốn hệ thống thử kết nối bot tổng kho để mua và giao lại đơn này cho khách? (Hãy đảm bảo đã nạp đủ số dư ví kho)')) return;
    try {
      const res = await fetch('/api/admin/orders/retry-delivery', {
        method: 'POST',
        headers: store.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ checkout_id: checkoutId })
      });
      const data = await res.json();
      if (data.success) {
        store.showToast(data.message || 'Giao hàng thành công!', 'success');
        this.loadAllOrders();
        this.loadStats();
      } else {
        store.showToast(data.error || 'Giao hàng thất bại. Vui lòng kiểm tra lại số dư kho.', 'error');
        this.loadAllOrders();
      }
    } catch (e) {
      store.showToast('Lỗi kết nối khi giao lại', 'error');
    }
  },

  promptManualDeliver(checkoutId) {
    const raw = prompt('Nhập danh sách tài khoản cần giao cho khách (nếu nhiều tài khoản, cách nhau bằng dấu xuống dòng):');
    if (!raw || !raw.trim()) return;
    const items = raw.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    if (items.length === 0) {
      store.showToast('Danh sách tài khoản không hợp lệ', 'error');
      return;
    }

    fetch('/api/admin/orders/manual-deliver', {
      method: 'POST',
      headers: store.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ checkout_id: checkoutId, items })
    }).then(r => r.json()).then(data => {
      if (data.success) {
        store.showToast('Đã cấp tài khoản thủ công cho khách thành công!', 'success');
        this.loadAllOrders();
        this.loadStats();
      } else {
        store.showToast(data.error || 'Thất bại', 'error');
      }
    }).catch(() => store.showToast('Lỗi kết nối', 'error'));
  }
};
