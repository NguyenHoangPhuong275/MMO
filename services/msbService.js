const fs = require('fs');
const path = require('path');

const MSB_BASE_URL = 'https://ebank.msb.com.vn/IBSRetail';
const MSB_LOGIN_URL = `${MSB_BASE_URL}/Request`;
const MSB_HISTORY_URL = `${MSB_BASE_URL}/history/byAccount.do`;
const MSB_REFRESH_URL = `${MSB_LOGIN_URL}?&dse_applicationId=-1&dse_pageId=1&dse_operationName=retailIndexProc&dse_errorPage=error_page.jsp&dse_processorState=initial&dse_nextEventName=start`;
const MSB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const UNKNOWN_RESPONSE_RETRIES = 2;

function cleanMemo(rawRemark) {
  const remark = String(rawRemark || '').trim();
  return remark.replace(/^(?:MSB\s+)?\d+-[A-Za-z0-9]+-/, '').trim();
}

function normalizeAmount(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return 0;
  const normalized = String(value).trim().replace(/,/g, '');
  if (!/^\d+$/.test(normalized)) return 0;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function normalizeTransaction(item) {
  if (!item || typeof item !== 'object' || String(item.dcSign || '').toUpperCase() !== 'C') return null;
  const transactionId = String(item.coreSn || item.tmSeq || item.tranSn || '').trim();
  const amountVnd = normalizeAmount(item.amount);
  if (!transactionId || amountVnd <= 0) return null;
  const rawRemark = String(item.remark || '');
  return {
    transactionId,
    amountVnd,
    description: cleanMemo(rawRemark) || rawRemark,
    rawPayload: JSON.stringify(item)
  };
}

class MsbService {
  constructor() {
    this.enabled = String(process.env.MSB_PAYMENT_ENABLED || 'false').toLowerCase() === 'true';
    this.username = process.env.MSB_USERNAME || '';
    this.password = process.env.MSB_PASSWORD || '';
    this.accountNumber = process.env.MSB_ACCOUNT_NUMBER || '';
    this.bankBin = process.env.MSB_BANK_BIN || '970426';
    this.accountName = process.env.BANK_ACCOUNT_NAME || '';
    this.antiCaptchaKey = process.env.MSB_ANTICAPTCHA_KEY || '';
    this.antiCaptchaUrl = (process.env.MSB_ANTICAPTCHA_URL || 'https://anticaptcha.top').replace(/\/$/, '');
    this.browserExecutablePath = process.env.MSB_BROWSER_EXECUTABLE_PATH || '';
    this.tokenNo = null;
    this.loginGeneration = 0;
    this.initialLoginAttempted = false;
    this.unknownResponseFailures = 0;
    this.maintenancePaused = false;
    this.playwright = null;
    this.context = null;
    this.page = null;
    this.loginPromise = null;
    this.fetchPromise = null;
  }

  isConfigured() {
    return Boolean(
      this.enabled
      && this.username.trim()
      && this.password.trim()
      && this.accountNumber.trim()
      && this.bankBin.trim()
      && this.accountName.trim()
      && this.antiCaptchaKey.trim()
    );
  }

  sessionReady() {
    return Boolean(this.tokenNo && this.context && this.page && !this.page.isClosed());
  }

  resolveBrowserExecutable() {
    if (this.browserExecutablePath.trim()) return this.browserExecutablePath.trim();
    if (process.platform !== 'win32') return undefined;
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    return candidates.find(candidate => fs.existsSync(candidate));
  }

  resetRecoveryState() {
    this.unknownResponseFailures = 0;
    this.maintenancePaused = false;
  }

  async solveCaptcha(imageBytes) {
    const createResponse = await fetch(`${this.antiCaptchaUrl}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: this.antiCaptchaKey,
        task: { type: 'ImageToTextTask', body: imageBytes.toString('base64') }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!createResponse.ok) return null;
    const created = await createResponse.json();
    if (created.errorId !== 0 || !created.taskId) return null;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const resultResponse = await fetch(`${this.antiCaptchaUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.antiCaptchaKey, taskId: created.taskId }),
        signal: AbortSignal.timeout(15000)
      });
      if (!resultResponse.ok) return null;
      const result = await resultResponse.json();
      if (result.status === 'ready') return String(result.solution?.text || '').trim() || null;
      if (result.errorId && result.errorId !== 0) return null;
    }
    return null;
  }

  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed()) return true;
    await this.closeBrowser();
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (error) {
      console.error('MSB unavailable: chưa cài package playwright');
      return false;
    }

    try {
      const profilePath = path.join(__dirname, '..', 'data', 'msb-browser');
      fs.mkdirSync(profilePath, { recursive: true });
      const executablePath = this.resolveBrowserExecutable();
      this.context = await chromium.launchPersistentContext(profilePath, {
        headless: true,
        userAgent: MSB_USER_AGENT,
        locale: 'vi-VN',
        ...(executablePath ? { executablePath } : {})
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      return true;
    } catch (error) {
      console.warn(`MSB browser start error: ${error.name}`);
      await this.closeBrowser();
      return false;
    }
  }

  async isLoginPage() {
    if (!this.page || this.page.isClosed()) return false;
    if (this.page.url().replace(/\/$/, '').toLowerCase().endsWith('/ibsretail/request')) return true;
    const content = (await this.page.content()).toLowerCase();
    return ['_username', 'msbpassword', 'safecode'].filter(marker => content.includes(marker)).length >= 2;
  }

  extractToken(content) {
    const patterns = [
      /name=["']tokenNo["'][^>]*value=["']([^"']+)/i,
      /value=["']([^"']+)["'][^>]*name=["']tokenNo["']/i
    ];
    for (const pattern of patterns) {
      const match = String(content || '').match(pattern);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return null;
  }

  async browserLogin() {
    if (!await this.ensureBrowser()) return false;
    let capturedToken = null;
    const requestListener = request => {
      const postData = request.postData() || '';
      if (!postData.includes('tokenNo=')) return;
      const token = new URLSearchParams(postData).get('tokenNo');
      if (token && !['null', 'undefined'].includes(token)) capturedToken = token.trim();
    };
    this.page.on('request', requestListener);

    try {
      await this.page.goto(MSB_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.locator('#_userName').fill(this.username);
      await this.page.locator('#msbPassword').fill(this.password);
      const captchaBytes = await this.page.locator('#safecode').screenshot();
      const captchaCode = await this.solveCaptcha(captchaBytes);
      if (!captchaCode) return false;
      const captchaInput = this.page.locator('input[name="_verifyCode"]');
      await captchaInput.fill(captchaCode);
      await captchaInput.press('Enter');
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 20000 });
      } catch (error) {
        await this.page.waitForTimeout(5000);
      }
      const content = await this.page.content();
      if (await this.isLoginPage()) return false;
      capturedToken ||= this.extractToken(content);
      const cookies = await this.context.cookies();
      const hasSession = cookies.some(cookie => cookie.name === 'JSESSIONID' && cookie.value);
      if (!capturedToken || !hasSession) return false;
      this.tokenNo = capturedToken;
      this.loginGeneration += 1;
      this.resetRecoveryState();
      console.log('✅ MSB read-only session initialized');
      return true;
    } catch (error) {
      console.warn(`MSB browser login error: ${error.name}`);
      return false;
    } finally {
      this.page?.off('request', requestListener);
    }
  }

  async refreshToken() {
    if (!await this.ensureBrowser()) return 'unknown';
    try {
      const response = await this.page.goto(MSB_REFRESH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response) return 'unknown';
      if ([401, 403].includes(response.status()) || await this.isLoginPage()) return 'expired';
      if (response.status() >= 400) return 'unknown';
      const token = this.extractToken(await this.page.content());
      if (!token) return 'unknown';
      this.tokenNo = token;
      this.resetRecoveryState();
      return 'refreshed';
    } catch (error) {
      return 'unknown';
    }
  }

  async ensureSession(allowLogin) {
    if (this.sessionReady()) return true;
    if (!allowLogin) return false;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      if (this.sessionReady()) return true;
      const refreshState = await this.refreshToken();
      if (refreshState === 'refreshed') return true;
      if (refreshState === 'unknown') return false;
      this.tokenNo = null;
      return this.browserLogin();
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async initializeSession() {
    if (this.initialLoginAttempted) return this.sessionReady();
    this.initialLoginAttempted = true;
    return this.ensureSession(true);
  }

  async historyRequest() {
    if (!await this.ensureBrowser()) throw new Error('browser_unavailable');
    return this.page.evaluate(async ({ url, data }) => {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: new URLSearchParams(data)
      });
      return { statusCode: response.status, url: response.url, text: await response.text() };
    }, {
      url: MSB_HISTORY_URL,
      data: {
        queryType: '0',
        acctNo: this.accountNumber,
        page: '1',
        tokenNo: this.tokenNo || '',
        lang: 'vi_VN'
      }
    });
  }

  parseHistoryResponse(response) {
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch (error) {
      payload = null;
    }
    if ([401, 403].includes(response.statusCode)) return { state: 'auth_failed', reason: `http_${response.statusCode}` };
    if (response.statusCode >= 400) return { state: 'unknown', reason: `http_${response.statusCode}` };
    if (payload && ['401', '403'].includes(String(payload.status || '').trim())) {
      return { state: 'auth_failed', reason: `payload_${payload.status}` };
    }
    if (String(response.url || '').replace(/\/$/, '').toLowerCase().endsWith('/ibsretail/request')) {
      return { state: 'auth_failed', reason: 'login_redirect' };
    }
    const body = String(response.text || '').toLowerCase();
    if (['_username', 'msbpassword', 'safecode'].filter(marker => body.includes(marker)).length >= 2) {
      return { state: 'auth_failed', reason: 'login_page' };
    }
    if (!payload || typeof payload !== 'object' || String(payload.status || '').trim() !== '200') {
      return { state: 'unknown', reason: 'unexpected_payload' };
    }
    const history = payload.data?.history;
    if (history === null || history === undefined) return { state: 'valid', rows: [] };
    if (!Array.isArray(history)) return { state: 'unknown', reason: 'invalid_history' };
    return { state: 'valid', rows: history.filter(row => row && typeof row === 'object') };
  }

  async fetchHistory(allowLogin) {
    const generation = this.loginGeneration;
    if (this.maintenancePaused) {
      if (!allowLogin) return null;
      this.resetRecoveryState();
      this.tokenNo = null;
    }
    if (!await this.ensureSession(allowLogin)) return null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = this.parseHistoryResponse(await this.historyRequest());
        if (result.state === 'valid') {
          this.resetRecoveryState();
          return result.rows || [];
        }
        if (result.state === 'auth_failed') {
          this.resetRecoveryState();
          if (attempt === 0) {
            const refreshed = await this.refreshToken();
            if (refreshed === 'refreshed') continue;
            if (refreshed === 'unknown') return null;
          }
          this.tokenNo = null;
          if (allowLogin && this.loginGeneration === generation && await this.ensureSession(true)) continue;
          return null;
        }
        this.unknownResponseFailures += 1;
        if (this.unknownResponseFailures > UNKNOWN_RESPONSE_RETRIES) this.maintenancePaused = true;
        return null;
      } catch (error) {
        this.unknownResponseFailures += 1;
        if (this.unknownResponseFailures > UNKNOWN_RESPONSE_RETRIES) this.maintenancePaused = true;
        return null;
      }
    }
    return null;
  }

  async fetchRecentTransactions({ allowLogin = true } = {}) {
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = (async () => {
      const rows = await this.fetchHistory(allowLogin);
      return rows ? rows.map(normalizeTransaction).filter(Boolean) : [];
    })();
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  async closeBrowser() {
    const context = this.context;
    this.page = null;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch (error) {
      }
    }
  }

  async close() {
    await this.closeBrowser();
    this.tokenNo = null;
    this.resetRecoveryState();
  }
}

const msbService = new MsbService();

module.exports = msbService;
module.exports.cleanMemo = cleanMemo;
module.exports.normalizeTransaction = normalizeTransaction;
