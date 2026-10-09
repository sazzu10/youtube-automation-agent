const path = require('path');
const fs = require('fs');
const os = require('os');

// Ensure environment variables from .env are available
try {
  require('dotenv').config();
} catch (_) {
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (m && !process.env[m[1]]) {
          let val = (m[2] || '').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[m[1]] = val;
        }
      }
    }
  } catch (_) {}
}

const OpenAI = require('openai');
const { Logger } = require('./logger');
const { GeminiKeyRotator } = require('./gemini-key-rotator');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.8-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    envKey: 'GROQ_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.credentials = credentials;
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.geminiModel = credentials.gemini?.videoModel || credentials.gemini?.model || GEMINI_DEFAULT_MODEL;
    this.providerName = null;
    this.cloudflareAI = null;
    this.cloudflareModel = '@cf/meta/llama-3.1-8b-fast-v2';
    this.keyRotator = new GeminiKeyRotator({ logger: this.logger });

    this._initCloudflare();
    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    } else {
      for (const [, preset] of Object.entries(PROVIDERS)) {
        const key = process.env[preset.envKey];
        if (key) {
          this._initOpenAICompatible(preset, key);
          break;
        }
      }
    }

    // Initialize Gemini support (available concurrently for multimodal even if OpenRouter handles text)
    if (this.keyRotator.getKeyCount() > 0) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        const activeKey = this.keyRotator.getAvailableKey()?.key;
        if (activeKey) {
          this.gemini = new GoogleGenAI({ apiKey: activeKey });
        }
        if (!this.client) {
          this.model = this.geminiModel;
          this.providerName = 'Google Gemini';
          this.logger.info(`Gemini initialized as primary (model: ${this.model}, ${this.keyRotator.getKeyCount()} key(s) available)`);
        } else {
          this.logger.info(`Gemini multimodal available in background (${this.keyRotator.getKeyCount()} key(s), model: ${this.geminiModel})`);
        }
      } catch (err) {
        this.logger.warn(`Failed initializing Gemini SDK: ${err.message}`);
      }
    }

    if (!this.client && !this.gemini) {
      this.logger.warn('No AI provider configured — text and multimodal generation unavailable');
    }
  }

  _initCloudflare() {
    try {
      const envPath = path.join(require('os').homedir(), '.cloudflare-workers-ai.env');
      if (!fs.existsSync(envPath)) return;
      const values = {};
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) values[m[1]] = m[2].trim();
      }
      if (values.CLOUDFLARE_API_TOKEN && values.CLOUDFLARE_ACCOUNT_ID) {
        this.cloudflareAI = {
          token: values.CLOUDFLARE_API_TOKEN,
          accountId: values.CLOUDFLARE_ACCOUNT_ID
        };
        this.logger.info('Cloudflare Workers AI fallback initialized');
      }
    } catch (error) {
      this.logger.warn('Cloudflare Workers AI fallback unavailable:', error.message);
    }
  }

  async _generateCloudflare(prompt, maxTokens) {
    if (!this.cloudflareAI) throw new Error('Cloudflare Workers AI fallback not configured');

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.cloudflareAI.accountId}/ai/run/${this.cloudflareModel}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.cloudflareAI.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, max_tokens: maxTokens })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(`Cloudflare Workers AI error: ${data?.errors?.[0]?.message || response.statusText}`);
    }

    const text =
      data?.result?.response ||
      data?.result?.choices?.[0]?.text ||
      data?.result?.choices?.[0]?.message?.content;

    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Cloudflare Workers AI returned an empty response');
    }

    return text.trim();
  }

  _initOpenAICompatible(preset, apiKey, model) {
    const clientOptions = { apiKey, baseURL: preset.baseURL };
    if (preset.name === 'OpenRouter' || preset.baseURL?.includes('openrouter.ai')) {
      clientOptions.defaultHeaders = {
        'HTTP-Referer': 'https://github.com/sazzu10/youtube-automation-agent',
        'X-Title': 'Lumen YouTube Automation'
      };
    }
    this.client = new OpenAI(clientOptions);
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || this.geminiModel || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    // 1. If Gemini is primary provider (or requested)
    if (this.gemini || (!this.client && this.keyRotator.getKeyCount() > 0)) {
      try {
        return await this.keyRotator.executeWithRotation(async (apiKey) => {
          const { GoogleGenAI } = require('@google/genai');
          const client = new GoogleGenAI({ apiKey });
          const config = { maxOutputTokens: maxTokens };
          if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;

          const response = await client.models.generateContent({
            model,
            contents: prompt,
            config,
          });
          const text = response && response.text;
          if (typeof text !== 'string' || !text.trim()) {
            throw new Error(
              `Gemini returned an empty response. Check the API key and model quota.`
            );
          }
          return text.trim();
        });
      } catch (error) {
        if (this.cloudflareAI) {
          this.logger.warn('Primary AI failed; using Cloudflare Workers AI fallback:', error.message);
          return this._generateCloudflare(prompt, maxTokens);
        }
        throw error;
      }
    }

    // 2. OpenAI / OpenRouter client
    if (!this.client) {
      if (this.cloudflareAI) return this._generateCloudflare(prompt, maxTokens);
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    try {
      const response = await this.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      return this._extractContent(response);
    } catch (error) {
      if (
        error &&
        error.status === 400 &&
        /max(_completion)?_tokens/i.test(error.message || '')
      ) {
        const response = await this.client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        return this._extractContent(response);
      }
      if (this.cloudflareAI) {
        this.logger.warn('Primary AI failed; using Cloudflare Workers AI fallback:', error.message);
        return this._generateCloudflare(prompt, maxTokens);
      }
      throw error;
    }
  }

  /**
   * Generates multimodal content (e.g. video frames + prompt).
   * Supports inlineData image parts via Gemini key rotation, falling back to OpenRouter vision if needed.
   *
   * @param {Array<Object|string>} parts - Array containing prompt string and image parts { inlineData: { mimeType, data } }
   * @param {Object} options - { model, maxTokens, temperature }
   * @returns {Promise<string>}
   */
  async generateMultimodalContent(parts, options = {}) {
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.2;

    // 1. Primary: Gemini Multimodal via Key Rotator
    if (this.keyRotator && this.keyRotator.getKeyCount() > 0) {
      const configuredModel = options.model || this.geminiModel || GEMINI_DEFAULT_MODEL;
      const modelCandidates = [
        configuredModel,
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-3.7-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
      ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

      try {
        const result = await this.keyRotator.executeWithRotation(async (apiKey) => {
          const { GoogleGenAI } = require('@google/genai');
          const client = new GoogleGenAI({ apiKey });

          const contents = [];
          for (const part of parts) {
            if (typeof part === 'string') {
              contents.push({ text: part });
            } else if (part.text) {
              contents.push({ text: part.text });
            } else if (part.inlineData) {
              contents.push({
                inlineData: {
                  mimeType: part.inlineData.mimeType || 'image/jpeg',
                  data: part.inlineData.data
                }
              });
            }
          }

          let lastErr = null;
          for (const targetModel of modelCandidates) {
            const config = { maxOutputTokens: maxTokens };
            if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(targetModel)) {
              config.temperature = temperature;
            }

            try {
              const response = await client.models.generateContent({
                model: targetModel,
                contents,
                config
              });
              const text = response && response.text;
              if (typeof text === 'string' && text.trim()) {
                return text.trim();
              }
              throw new Error('Gemini returned an empty multimodal response');
            } catch (err) {
              lastErr = err;
              if (/not found|404|unsupported model/i.test(err.message || '')) {
                this.logger.warn(`Model ${targetModel} not supported by endpoint; trying fallback candidate...`);
                continue;
              }
              throw err;
            }
          }
          throw lastErr || new Error('All candidate Gemini models failed');
        });

        if (result) return result;
      } catch (geminiErr) {
        this.logger.warn(`Gemini multimodal analysis failed (${geminiErr.message}); proceeding to fallback...`);
      }
    }

    // 2. Multimodal Fallback: OpenRouter / OpenAI vision
    if (this.client) {
      this.logger.info(`Attempting multimodal fallback via ${this.providerName}...`);
      const contentParts = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          contentParts.push({ type: 'text', text: part });
        } else if (part.text) {
          contentParts.push({ type: 'text', text: part.text });
        } else if (part.inlineData) {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`,
              detail: 'low'
            }
          });
        }
      }

      const visionCandidates = [
        options.openRouterModel,
        'google/gemini-2.5-flash',
        'google/gemini-2.5-flash-lite',
        'google/gemini-3.7-flash',
        'google/gemini-3.8-flash'
      ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

      // Token budget: use caller-supplied maxTokens; default 1500 (enough for structured JSON schema)
      let targetTokens = maxTokens || 1500;
      let lastError = null;

      for (const modelCandidate of visionCandidates) {
        let attempt = 0;
        const maxAttemptsForModel = 2; // Bounded retry for transient 503/429

        while (attempt < maxAttemptsForModel) {
          attempt++;
          try {
            const response = await this.client.chat.completions.create({
              model: modelCandidate,
              messages: [{ role: 'user', content: contentParts }],
              max_tokens: targetTokens,
              temperature
            });
            const content = this._extractContent(response);
            if (!content || !content.trim()) {
              throw new Error(`Empty response received from ${modelCandidate}`);
            }
            // Detect truncated JSON: starts with '{' but doesn't end with '}'
            const trimmed = content.trim();
            if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
              const finishReason = response?.choices?.[0]?.finish_reason;
              throw new Error(`Truncated JSON from ${modelCandidate} (finish_reason=${finishReason}); increase maxTokens or check quota`);
            }
            return content;
          } catch (openRouterErr) {
            lastError = openRouterErr;
            const errMsg = String(openRouterErr.message || '');
            const errStatus = openRouterErr.status || openRouterErr.statusCode;

            // 1. Model unavailable / 404: Do not retry this model; skip immediately to next candidate
            if (errStatus === 404 || /no endpoints found|not found|unsupported model|endpoint not found/i.test(errMsg)) {
              this.logger.warn?.(`Multimodal model ${modelCandidate} unavailable on endpoint (404/no endpoints); trying next vision candidate...`);
              break;
            }

            // 2. OpenRouter 402 budget adaptation ("can only afford X tokens")
            const affordMatch = errMsg.match(/can only afford (\d+)/i);
            if (affordMatch) {
              const affordable = parseInt(affordMatch[1], 10);
              if (affordable >= 300) {
                targetTokens = Math.max(300, affordable - 50);
                this.logger.warn?.(`Adjusting OpenRouter token limit to ${targetTokens} tokens based on available balance...`);
                continue;
              }
            }

            // 3. Transient 503 / 429 errors: Bounded exponential backoff
            const isTransient = errStatus === 503 || errStatus === 429 || /503|429|service unavailable|high demand|overloaded|rate limit|too many requests/i.test(errMsg);
            if (isTransient && attempt < maxAttemptsForModel) {
              const backoffMs = attempt * 1500;
              this.logger.warn?.(`Multimodal model ${modelCandidate} transient error (${errMsg.slice(0, 80)}). Retrying in ${backoffMs}ms...`);
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }

            this.logger.warn?.(`Multimodal model ${modelCandidate} failed (${errMsg.slice(0, 90)}); trying next vision candidate...`);
            break;
          }
        }
      }

      this.logger.error(`All OpenRouter multimodal fallback candidates failed: ${lastError?.message}`);
      throw lastError || new Error('All OpenRouter multimodal fallback candidates failed');
    }

    throw new Error('No multimodal AI provider available (Gemini keys exhausted and no OpenRouter vision client)');
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return Boolean(this.client || this.gemini || (this.keyRotator && this.keyRotator.getKeyCount() > 0));
  }

  isMultimodalAvailable() {
    return Boolean((this.keyRotator && this.keyRotator.getKeyCount() > 0) || this.client);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
