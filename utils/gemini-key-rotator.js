const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');

/**
 * Manages Gemini API keys across config/credentials.json and spare .gemini-key* files.
 * Handles automatic key rotation, rate-limit cooldowns (429 / RESOURCE_EXHAUSTED),
 * and secure credential handling (never exposes keys in logs).
 */
class GeminiKeyRotator {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('GeminiKeyRotator');
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
    this.credentialsPath = options.credentialsPath || path.join(this.repoRoot, 'config', 'credentials.json');
    this.cooldownMs = options.cooldownMs || 60000; // 60s cooldown for rate-limited keys
    this.keys = [];
    this.currentIndex = 0;
    this.reloadKeys();
  }

  maskKey(key) {
    if (!key || typeof key !== 'string') return 'none';
    if (key.length <= 12) return `${key.slice(0, 4)}...`;
    return `${key.slice(0, 8)}...${key.slice(-4)}`;
  }

  reloadKeys() {
    const candidateKeys = [];

    // 1. Primary key from config/credentials.json
    try {
      if (fs.existsSync(this.credentialsPath)) {
        const raw = fs.readFileSync(this.credentialsPath, 'utf8');
        const creds = JSON.parse(raw);
        if (creds.gemini?.apiKey && typeof creds.gemini.apiKey === 'string') {
          const k = creds.gemini.apiKey.trim();
          if (k.length > 10) {
            candidateKeys.push({ source: 'config/credentials.json', key: k });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Failed reading credentials.json for Gemini keys: ${err.message}`);
    }

    // 2. Environment variable GEMINI_API_KEY
    if (process.env.GEMINI_API_KEY && typeof process.env.GEMINI_API_KEY === 'string') {
      const k = process.env.GEMINI_API_KEY.trim();
      if (k.length > 10) {
        candidateKeys.push({ source: 'process.env.GEMINI_API_KEY', key: k });
      }
    }

    // 3. Additional spare keys: .gemini-key2 through .gemini-key10
    for (let i = 2; i <= 10; i++) {
      const keyFile = path.join(this.repoRoot, `.gemini-key${i}`);
      try {
        if (fs.existsSync(keyFile)) {
          const content = fs.readFileSync(keyFile, 'utf8').trim();
          if (content && content.length >= 20) {
            candidateKeys.push({ source: `.gemini-key${i}`, key: content });
          }
        }
      } catch (_) {}
    }

    // Deduplicate candidate keys while preserving order
    const seen = new Set();
    const uniqueKeys = [];
    for (const item of candidateKeys) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        uniqueKeys.push(item);
      }
    }

    // Preserve cooldown states if reloading
    const existingMap = new Map(this.keys.map(k => [k.key, k]));
    this.keys = uniqueKeys.map((item, idx) => {
      const existing = existingMap.get(item.key);
      return {
        id: idx + 1,
        source: item.source,
        key: item.key,
        masked: this.maskKey(item.key),
        exhaustedUntil: existing ? existing.exhaustedUntil : 0,
        failCount: existing ? existing.failCount : 0,
        successCount: existing ? existing.successCount : 0
      };
    });

    this.logger.info(`Loaded ${this.keys.length} Gemini API key(s) for rotation`);
  }

  isRateLimitError(error) {
    if (!error) return false;
    const msg = String(error.message || error.statusText || error || '');
    const status = error.status || error.statusCode || error.code || error.response?.status;
    if (status === 429 || status === '429') return true;
    return /RESOURCE_EXHAUSTED|rateLimitExceeded|quotaExceeded|Too Many Requests|quota exceeded|429/i.test(msg);
  }

  isTransientError(error) {
    if (!error) return false;
    const msg = String(error.message || error.statusText || error || '');
    const status = error.status || error.statusCode || error.code || error.response?.status;
    if (status === 503 || status === '503') return true;
    return /503|service unavailable|high demand|overloaded|temporarily unavailable|backend error/i.test(msg);
  }

  isNetworkError(error) {
    if (!error) return false;
    const msg = String(error.message || error.statusText || error || '');
    const code = String(error.code || error.cause?.code || '');
    return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|network error|socket hang up/i.test(msg) ||
           /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT/i.test(code);
  }

  getAvailableKey() {
    if (!this.keys.length) {
      this.reloadKeys();
      if (!this.keys.length) return null;
    }

    const now = Date.now();
    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const idx = (this.currentIndex + attempt) % this.keys.length;
      const keyObj = this.keys[idx];
      if (now >= keyObj.exhaustedUntil) {
        this.currentIndex = idx;
        return keyObj;
      }
    }

    return null;
  }

  markKeyExhausted(keyOrObj, customCooldownMs) {
    const now = Date.now();
    const cooldown = customCooldownMs || this.cooldownMs;
    const keyStr = typeof keyOrObj === 'string' ? keyOrObj : keyOrObj.key;
    const found = this.keys.find(k => k.key === keyStr);
    if (found) {
      found.exhaustedUntil = now + cooldown;
      found.failCount += 1;
      this.logger.warn(
        `Gemini key #${found.id} (${found.masked} from ${found.source}) rate-limited / exhausted. Cooling down for ${Math.round(cooldown / 1000)}s.`
      );
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }
  }

  markKeySuccess(keyOrObj) {
    const keyStr = typeof keyOrObj === 'string' ? keyOrObj : keyOrObj.key;
    const found = this.keys.find(k => k.key === keyStr);
    if (found) {
      found.successCount += 1;
      found.exhaustedUntil = 0;
    }
  }

  /**
   * Executes a Gemini API operation with automatic key rotation on 429/quota errors.
   * @param {Function} operationFn - async (apiKey, keyObj) => result
   * @returns {Promise<any>}
   */
  async executeWithRotation(operationFn) {
    if (!this.keys.length) {
      this.reloadKeys();
      if (!this.keys.length) {
        throw new Error('No Gemini API keys configured');
      }
    }

    const totalKeys = this.keys.length;
    let lastError = null;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const keyObj = this.getAvailableKey();
      if (!keyObj) {
        const error = new Error(`All ${totalKeys} Gemini API keys are currently rate-limited or cooling down`);
        error.code = 'ALL_GEMINI_KEYS_EXHAUSTED';
        error.status = 429;
        throw error;
      }

      try {
        const result = await operationFn(keyObj.key, keyObj);
        this.markKeySuccess(keyObj);
        return result;
      } catch (err) {
        lastError = err;
        if (this.isRateLimitError(err)) {
          this.markKeyExhausted(keyObj);
          this.logger.info(`Rotating to next Gemini key... (attempt ${attempt + 1}/${totalKeys})`);
          continue;
        }
        if (this.isTransientError(err)) {
          const backoffMs = Math.min(1000 * Math.pow(1.5, attempt), 3000);
          this.logger.warn(
            `Gemini transient 503/high demand error (${err.message?.slice(0, 80)}). Waiting ${backoffMs}ms before rotating key... (attempt ${attempt + 1}/${totalKeys})`
          );
          await new Promise(r => setTimeout(r, backoffMs));
          this.currentIndex = (this.currentIndex + 1) % this.keys.length;
          continue;
        }
        if (this.isNetworkError(err)) {
          this.logger.warn(
            `Gemini network connection unreachable (${err.message}). Yielding to fallback providers.`
          );
          const netErr = new Error(`Gemini network connection unreachable: ${err.message}`);
          netErr.code = 'GEMINI_NETWORK_UNREACHABLE';
          throw netErr;
        }
        // Non-rate-limit/non-transient errors (e.g. invalid arguments, 400, model issues) rethrow immediately
        throw err;
      }
    }

    const error = new Error(`All Gemini keys failed. Last error: ${lastError?.message || 'Rate limit'}`);
    error.code = 'ALL_GEMINI_KEYS_EXHAUSTED';
    error.status = 429;
    throw error;
  }

  getKeyCount() {
    return this.keys.length;
  }
}

module.exports = { GeminiKeyRotator };
