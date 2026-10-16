const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

class MagicHourProvider {
  constructor(credentials = {}, options = {}) {
    this.id = 'magic_hour';
    this.model = options.model || process.env.MAGIC_HOUR_VIDEO_MODEL || 'ltx-2.3';
    this.apiKey = options.apiKey || process.env.MAGIC_HOUR_API_KEY || credentials.magic_hour?.apiKey;
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  describe() {
    return {
      id: this.id,
      model: this.model,
      capabilities: {
        minDuration: 5,
        maxDuration: 30,
        defaultResolution: '720p',
        maxPromptLength: 2000,
        text: true,
        firstFrame: false,
        lastFrame: false,
        referenceImages: 0,
        referenceVideos: 0,
        referenceAudios: 0,
        nativeAudio: true
      }
    };
  }

  supports(request = {}) {
    const duration = Number(request.duration || 8);
    return duration >= 5 && duration <= 30 && Boolean(request.prompt);
  }

  normalizeRequest(input = {}) {
    return {
      ...input,
      duration: Math.max(5, Math.min(30, Number(input.duration || 8))),
      resolution: String(input.resolution || '720p').toLowerCase(),
      aspectRatio: input.aspectRatio || '9:16',
      generateAudio: Boolean(input.generateAudio),
      prompt: String(input.prompt || '').slice(0, 2000)
    };
  }

  async client() {
    if (!this._client) {
      const { Client } = await import('magic-hour');
      this._client = new Client({ token: this.apiKey });
    }
    return this._client;
  }

  async createTask(input = {}) {
    if (!this.isAvailable()) {
      throw new Error('Magic Hour API key is not configured');
    }

    const request = this.normalizeRequest(input);
    const client = await this.client();

    const result = await client.v1.textToVideo.create({
      model: this.model,
      endSeconds: request.duration,
      aspectRatio: request.aspectRatio,
      orientation: request.aspectRatio === '9:16' ? 'portrait' : 'landscape',
      resolution: request.resolution,
      audio: request.generateAudio,
      name: 'youtube-automation',
      style: {
        prompt: request.prompt,
        qualityMode: 'quick'
      }
    });

    if (!result?.id) {
      throw new Error('Magic Hour did not return a project id');
    }

    return {
      externalTaskId: result.id,
      status: 'queued',
      outputUrl: null,
      error: null,
      model: this.model
    };
  }

  async getTask(id) {
    const client = await this.client();

    const result = await client.v1.videoProjects.checkResult(
      { id },
      { waitForCompletion: false, downloadOutputs: false }
    );

    const status = String(result?.status || '').toLowerCase();

    if (status === 'complete') {
      const downloads = Array.isArray(result.downloads) ? result.downloads : [];
      const outputUrl = downloads.find(item => item?.url)?.url || null;

      return {
        externalTaskId: id,
        status: 'succeeded',
        outputUrl,
        error: null,
        model: this.model
      };
    }

    if (status === 'error') {
      throw new Error(
        result?.error?.message || 'Magic Hour video generation failed'
      );
    }

    if (status === 'canceled' || status === 'cancelled') {
      return {
        externalTaskId: id,
        status: 'cancelled',
        outputUrl: null,
        error: 'Magic Hour generation cancelled',
        model: this.model
      };
    }

    return {
      externalTaskId: id,
      status: status === 'queued' ? 'queued' : 'running',
      outputUrl: null,
      error: null,
      model: this.model
    };
  }

  async downloadResult(task, outputPath) {
    if (!task?.outputUrl) {
      throw new Error('Magic Hour returned no download URL');
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const response = await axios.get(task.outputUrl, {
      responseType: 'stream',
      timeout: 120000
    });

    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(require('fs').createWriteStream(outputPath));
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
}

module.exports = { MagicHourProvider };
