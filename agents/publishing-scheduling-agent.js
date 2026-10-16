const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');
const {
  computeFileContentHash,
  checkDuplicatePublish
} = require('../utils/content-identity');
const {
  getNextAvailableScheduleSlot,
  getTimezone,
  getLocalDateString,
  getDailyTarget
} = require('../utils/schedule-calculator');

class PublishingSchedulingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
    this.uploadPausedUntil = 0;
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    const pausedUntil = Number(await this.db.getSetting('youtube_upload_paused_until') || 0);
    this.uploadPausedUntil = Number.isFinite(pausedUntil) ? pausedUntil : 0;
    if (this.uploadPausedUntil > Date.now()) this.logger.warn(`YouTube uploads remain paused until ${new Date(this.uploadPausedUntil).toISOString()}`);
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

  async scheduleContent(productionData) {
    try {
      const finalVideo = productionData.assets?.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        this.logger.warn(`Not scheduling ${productionData.id}: no real video file was produced (placeholder/simulated output). Fix your AI provider keys and FFmpeg, then regenerate.`);
        return null;
      }
      if (!await this.isNarrationReady(productionData.assets?.audio)) {
        this.logger.warn(`Not scheduling ${productionData.id}: narration is missing. Regenerate narration or explicitly confirm an intentional silent video.`);
        return null;
      }

      this.logger.info(`Scheduling content: ${productionData.id}`);

      // Cryptographic Content Deduplication
      const finalVideoPath = productionData.assets?.finalVideo?.path;
      const contentHash = productionData.contentHash ||
        (finalVideoPath && fsSync.existsSync(finalVideoPath) ? computeFileContentHash(finalVideoPath) : null);

      if (contentHash) {
        const dupCheck = await checkDuplicatePublish({
          db: this.db,
          contentHash,
          platform: 'youtube',
          productionId: productionData.id
        });
        if (dupCheck.isDuplicate) {
          this.logger.warn(`DUPLICATE DETECTED: Content ${contentHash.slice(0, 12)} already published on YouTube (${dupCheck.record?.youtube_id || dupCheck.record?.platform_post_id}). Skipping new schedule.`);
          return dupCheck.record;
        }
      }

      const existing = await this.db.getLatestScheduleEntry?.(productionData.id);
      if (existing) {
        if (['scheduled', 'paused'].includes(existing.status) && !this.publishQueue.some(entry => entry.id === existing.id)) {
          this.publishQueue.push(existing);
          this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        }
        this.logger.info(`Reusing existing ${existing.status} schedule entry for: ${productionData.id}`);
        return existing;
      }

      // Permanent source-level duplicate protection
      const sourceOriginalPath =
        productionData.sourceOriginalPath ||
        productionData.assets?.sourceOriginalPath;

      if (sourceOriginalPath && this.db.getRow) {
        const sourceExisting = await this.db.getRow(
          `SELECT q.*
           FROM publish_schedule q
           JOIN productions p ON p.id = q.production_id
           WHERE json_extract(p.assets, '$.sourceOriginalPath') = ?
             AND q.status IN (
               'scheduled',
               'paused',
               'uploading',
               'published',
               'reconciliation_required'
             )
           ORDER BY q.created_at DESC
           LIMIT 1`,
          [sourceOriginalPath]
        );

        if (sourceExisting) {
          const reused = this.db.deserializeScheduleEntry
            ? this.db.deserializeScheduleEntry(sourceExisting)
            : sourceExisting;

          if (['scheduled', 'paused'].includes(reused.status) &&
              !this.publishQueue.some(entry => entry.id === reused.id)) {
            this.publishQueue.push(reused);
            this.publishQueue.sort((a, b) =>
              new Date(a.publishTime) - new Date(b.publishTime)
            );
          }

          this.logger.info(
            `Skipping duplicate source schedule: ${sourceOriginalPath} | existing=${reused.id} | status=${reused.status}`
          );

          return reused;
        }
      }

      // Calculate schedule slot obeying daily target (6/day) if needed
      let scheduledPublishTime = productionData.scheduledPublishTime;
      if (!scheduledPublishTime || new Date(scheduledPublishTime).getTime() <= Date.now()) {
        scheduledPublishTime = await getNextAvailableScheduleSlot({
          db: this.db,
          platform: 'youtube'
        });
      }

      const scheduleEntry = {
        productionId: productionData.id,
        title: productionData.script.title,
        publishTime: scheduledPublishTime,
        status: 'scheduled',
        priority: productionData.priority,
        content_hash: contentHash,
        idempotency_key: `yt_${contentHash || productionData.id}`,
        metadata: {
          seo: productionData.seo,
          thumbnail: productionData.assets.thumbnail,
          video: productionData.assets.finalVideo,
          audio: productionData.assets.audio,
          captions: productionData.assets.captions,
          privacyStatus: productionData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'public',
          containsSyntheticMedia: productionData.containsSyntheticMedia === true,
          contentType: productionData.contentType || 'short_form',
          sourceProductionId: productionData.sourceProductionId || productionData.id,
          shortClipId: productionData.shortClipId || null,
          contentHash
        },
        createdAt: new Date().toISOString()
      };
      
      const saved = await this.db.saveScheduleEntry(scheduleEntry) || scheduleEntry;
      this.publishQueue.push(saved);
      this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      
      this.logger.info(`Content scheduled for: ${saved.publishTime}`);
      return saved;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  isDeferrable(error, entry) {
    const msg = String((error && error.message) || error || '');
    const quota = /quota|exceeded the number of videos|rateLimitExceeded|uploadLimitExceeded/i.test(msg);
    const net = /socket disconnected|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|TLS connection|oauth2\.googleapis\.com/i.test(msg);
    const preConn = /oauth2\.googleapis\.com\/token|before secure TLS connection|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg);
    return quota || preConn || (net && !entry.uploadAttempted);
  }

  async deferEntry(entry, error) {
    const msg = String((error && error.message) || error || '');
    if (/quota|exceeded the number of videos|rateLimitExceeded|uploadLimitExceeded/i.test(msg)) {
      this.uploadPausedUntil = Date.now() + 6 * 60 * 60 * 1000;
      await this.db.setSetting('youtube_upload_paused_until', String(this.uploadPausedUntil), 'Persistent YouTube upload-limit pause expiry');
      this.logger.warn('YouTube upload limit reached; pausing uploads for 6 hours. Videos stay scheduled.');
      entry.publishTime = new Date(this.uploadPausedUntil + Math.floor(Math.random() * 5 * 60 * 1000)).toISOString();
    } else {
      // Exponential backoff with jitter for genuinely transient network/socket errors
      const attempt = Math.min(Number(entry.retry_count || 0) + 1, 6);
      const baseMs = Math.min(30 * 60 * 1000, 2000 * Math.pow(2, attempt));
      const jitterMs = Math.floor(Math.random() * 10000);
      const delayMs = baseMs + jitterMs;
      entry.publishTime = new Date(Date.now() + delayMs).toISOString();
      entry.retry_count = attempt;
    }
    entry.status = 'scheduled';
    entry.error = 'Deferred, will retry: ' + msg.slice(0, 200);
    await this.db.updateScheduleEntry(entry);
    try { await this.syncShortStatus(entry, 'scheduled', entry.error); } catch (_e) { /* ignore */ }
    error.code = 'UPLOAD_DEFERRED';
  }

  async publishContent(contentId, options = {}) {
    try {
      let productionBundle = null;
      if (this.db.getLatestReadinessRun) {
        const readiness = await this.db.getLatestReadinessRun();
        if (readiness?.status === 'failed') {
          const failures = readiness.checks
            .filter(check => check.blocking && check.status === 'failed')
            .map(check => check.id);
          const error = new Error(`Publishing is blocked by the production readiness gate. Fix ${failures.join(', ')} and run the check again.`);
          error.status = 409;
          error.code = 'READINESS_BLOCKED';
          throw error;
        }
      }
      if (this.db.getProductionBundle) {
        productionBundle = await this.db.getProductionBundle(contentId);
        if (productionBundle && !['verified', 'not_required'].includes(productionBundle.provenance?.status || 'not_required')) {
          const error = new Error('Publishing is blocked until every factual claim is supported or explicitly waived');
          error.status = 409;
          error.code = 'PROVENANCE_BLOCKED';
          throw error;
        }
      }
      this.logger.info(`Publishing content: ${contentId}`);
      
      let scheduleEntry = this.publishQueue.find(entry =>
        entry.productionId === contentId || entry.id === contentId
      );
      if (!scheduleEntry && this.db.getLatestScheduleEntry) {
        scheduleEntry = await this.db.getLatestScheduleEntry(contentId);
      }
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      if (scheduleEntry.status === 'published') return scheduleEntry;
      if (!await this.isNarrationReady(scheduleEntry.metadata?.audio || productionBundle?.assets?.audio)) {
        const error = new Error('Publishing is blocked because narration is missing or the intentional-silence override is incomplete');
        error.status = 409;
        error.code = 'NARRATION_REQUIRED';
        throw error;
      }
      if (scheduleEntry.youtubeId) {
        return this.reconcileUploadedVideo(scheduleEntry);
      }

      // Pre-upload cryptographic duplicate prevention
      const finalVideoPath = scheduleEntry.metadata?.video?.path;
      const contentHash = scheduleEntry.content_hash ||
        (finalVideoPath && fsSync.existsSync(finalVideoPath) ? computeFileContentHash(finalVideoPath) : null);

      if (contentHash) {
        const dupCheck = await checkDuplicatePublish({
          db: this.db,
          contentHash,
          platform: 'youtube',
          productionId: scheduleEntry.productionId
        });
        if (dupCheck.isDuplicate && (dupCheck.record?.youtube_id || dupCheck.record?.platform_post_id)) {
          const recordedId = dupCheck.record?.youtube_id || dupCheck.record?.platform_post_id;
          this.logger.warn(`DUPLICATE PREVENTED: Video ${contentHash.slice(0, 12)} is already published on YouTube (${recordedId}). Reconciling without re-upload.`);
          scheduleEntry.youtubeId = recordedId;
          scheduleEntry.youtubeUrl = dupCheck.record?.youtube_url || dupCheck.record?.platform_url || `https://www.youtube.com/watch?v=${recordedId}`;
          scheduleEntry.status = 'published';
          scheduleEntry.publishedAt = dupCheck.record?.published_at || new Date().toISOString();
          scheduleEntry.error = null;
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.syncShortStatus(scheduleEntry, 'published');
          this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
          return scheduleEntry;
        }
      }

      // Hard block: if the entry reached 'reconciliation_required' (a prior
      // upload outcome is unknown), never attempt a fresh upload.  Re-read
      // from DB first so we reflect any startup markInterruptedJobs() promotion
      // even when the in-memory publishQueue still shows the old status.
      {
        const liveEntry = this.db.getLatestScheduleEntry
          ? (await this.db.getLatestScheduleEntry(scheduleEntry.productionId) || scheduleEntry)
          : scheduleEntry;
        if (liveEntry.status === 'reconciliation_required') {
          const error = new Error(
            'A previous upload may have reached YouTube without returning a video ID. ' +
            'Reconcile the channel before attempting another upload.'
          );
          error.status = 409;
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          throw error;
        }
        // Keep in-memory entry in sync with the live row's status
        if (liveEntry.status && liveEntry.status !== scheduleEntry.status) {
          scheduleEntry.status = liveEntry.status;
        }
      }

      // Atomic lock claim
      if (this.db.claimPublishScheduleItem) {
        const claimed = await this.db.claimPublishScheduleItem(scheduleEntry.id, `yt_worker_${process.pid}`);
        if (!claimed) {
          this.logger.info(`Schedule item ${scheduleEntry.id} already claimed by another worker; skipping.`);
          return scheduleEntry;
        }
      }

      scheduleEntry.status = 'uploading';
      scheduleEntry.error = null;
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'uploading');
      
      let uploadResult;
      try {
        uploadResult = await this.uploadToYouTube(scheduleEntry, options);
      } catch (error) {
        if (this.db.releasePublishScheduleItem) {
          await this.db.releasePublishScheduleItem(scheduleEntry.id, 'scheduled', error.message).catch(() => {});
        }
        if (this.isDeferrable(error, scheduleEntry)) { await this.deferEntry(scheduleEntry, error); throw error; }
      if (scheduleEntry.uploadAttempted && this.isUploadOutcomeUnknown(error)) {
          scheduleEntry.status = 'reconciliation_required';
          scheduleEntry.error = 'Upload outcome is unknown; verify the YouTube channel before retrying';
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          error.status = 409;
        } else {
          if (this.isDeferrable(error, scheduleEntry)) { await this.deferEntry(scheduleEntry, error); throw error; }
        scheduleEntry.status = 'failed';
          scheduleEntry.error = error.message;
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.syncShortStatus(scheduleEntry, 'failed', error.message);
        }
        throw error;
      }
      
      // Update database and registry
      scheduleEntry.status = 'published';
      scheduleEntry.publishedAt = new Date().toISOString();
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      scheduleEntry.error = null;
      
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'published');

      if (contentHash && this.db.savePublishedMediaRegistry) {
        await this.db.savePublishedMediaRegistry({
          contentHash,
          platform: 'youtube',
          productionId: scheduleEntry.productionId,
          platformPostId: uploadResult.id,
          platformUrl: scheduleEntry.youtubeUrl,
          publishedAt: scheduleEntry.publishedAt
        }).catch(() => {});
      }
      
      // Remove from queue
      this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
      
      this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
      return scheduleEntry;
    } catch (error) {
      this.logger.error(
        `Failed to publish content: ${error?.message || String(error)} | code=${error?.code || ''} | status=${error?.status || error?.response?.status || ''} | response=${JSON.stringify(error?.response?.data || '')}`
      );
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry, options = {}) {
    const { metadata } = scheduleEntry;
    const validation = assertValidYouTubeMetadata(metadata.seo);
    if (validation.warnings.length) {
      this.logger.warn(`YouTube metadata warnings: ${validation.warnings.join(' ')}`);
    }
    const safeMetadata = validation.value;
    
    // Prepare video metadata
    const requestedPrivacy = metadata.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'public';
    const scheduledFor = new Date(scheduleEntry.publishTime);
    const futureSchedule = !options.publishNow && Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 60000;
    const videoMetadata = {
      snippet: {
        title: safeMetadata.title,
        description: safeMetadata.description,
        tags: safeMetadata.tags,
        categoryId: safeMetadata.categoryId,
        defaultLanguage: safeMetadata.defaultLanguage,
        defaultAudioLanguage: safeMetadata.defaultAudioLanguage
      },
      status: {
        privacyStatus: requestedPrivacy,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: metadata.containsSyntheticMedia === true
      }
    };
    // Direct public upload: no YouTube publishAt/private staging.
    
    // Resolve the file before marking the network upload as attempted.
    const videoStream = await this.getVideoStream(metadata.video.path);
    scheduleEntry.uploadAttempted = true;
    let videoUpload;
    try {
      videoUpload = await this.youtube.videos.insert({
        part: 'snippet,status',
        requestBody: videoMetadata,
        media: {
          body: videoStream
        }
      });
    } finally {
      if (videoStream && typeof videoStream.destroy === 'function') {
        videoStream.destroy();
      }
    }
    
    const videoId = videoUpload?.data?.id;
    if (!videoId) {
      throw new Error('YouTube videos.insert succeeded but returned no valid video ID in response');
    }
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    scheduleEntry.status = 'uploaded';
    scheduleEntry.youtubeId = videoId;
    scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    
    // Upload thumbnail
    if (metadata.thumbnail && metadata.thumbnail.path) {
      await this.uploadThumbnail(videoId, metadata.thumbnail.path);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }

  async isNarrationReady(audio = {}) {
    if (audio.intentionalSilence === true) {
      return String(audio.silenceReason || '').trim().length >= 10 && Boolean(audio.silenceConfirmedAt);
    }
    if (!audio.path || audio.simulated || String(audio.path).endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audio.path);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isUploadOutcomeUnknown(error) {
    const status = Number(error.status || error.response?.status || 0);
    return !status || status >= 500;
  }

  async reconcileUploadedVideo(scheduleEntry) {
    const response = await this.youtube.videos.list({ part: 'id,status', id: scheduleEntry.youtubeId });
    if (!response.data.items?.some(video => video.id === scheduleEntry.youtubeId)) {
      scheduleEntry.status = 'reconciliation_required';
      scheduleEntry.error = 'The recorded YouTube video ID could not be verified';
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
      const error = new Error('The recorded upload could not be verified on YouTube. Resolve it before attempting another upload.');
      error.status = 409;
      error.code = 'UPLOAD_OUTCOME_UNKNOWN';
      throw error;
    }
    scheduleEntry.status = 'published';
    scheduleEntry.publishedAt = scheduleEntry.publishedAt || new Date().toISOString();
    scheduleEntry.youtubeUrl = scheduleEntry.youtubeUrl || `https://www.youtube.com/watch?v=${scheduleEntry.youtubeId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    await this.syncShortStatus(scheduleEntry, 'published');
    this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
    this.logger.success(`Reconciled existing YouTube upload: ${scheduleEntry.youtubeUrl}`);
    return scheduleEntry;
  }

  async getChannelUploadsCountToday(timezone = 'America/Los_Angeles') {
    if (!this.youtube) return null;
    try {
      const channelRes = await this.youtube.channels.list({
        part: 'contentDetails',
        mine: true
      });
      const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) return null;

      const playlistRes = await this.youtube.playlistItems.list({
        part: 'snippet',
        playlistId: uploadsPlaylistId,
        maxResults: 15
      });

      const todayStr = getLocalDateString(new Date(), timezone);
      const items = playlistRes.data.items || [];
      const uploadsToday = items.filter(item => {
        const publishedAt = item.snippet?.publishedAt;
        if (!publishedAt) return false;
        return getLocalDateString(new Date(publishedAt), timezone) === todayStr;
      });

      this.logger.info(`YouTube Channel API check: ${uploadsToday.length} video(s) uploaded today (${todayStr} [${timezone}])`);
      return { count: uploadsToday.length, items: uploadsToday };
    } catch (err) {
      this.logger.warn(`Could not fetch channel uploads from YouTube API: ${err.message}`);
      return null;
    }
  }

  async syncShortStatus(scheduleEntry, status, error = null) {
    const clipId = scheduleEntry.metadata?.shortClipId;
    if (!clipId || !this.db.updateShortClip) return null;
    return this.db.updateShortClip(clipId, {
      status,
      scheduleId: scheduleEntry.id,
      youtubeId: scheduleEntry.youtubeId || null,
      youtubeUrl: scheduleEntry.youtubeUrl || null,
      error
    });
  }

  async getVideoStream(videoPath) {
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
        throw new Error('placeholder asset');
      }

      return fsSync.createReadStream(videoPath);
    } catch (error) {
      throw new Error('video file not found — refusing to upload placeholder');
    }
  }
  async uploadThumbnail(videoId, thumbnailPath) {
    try {
      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      
      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      
      this.logger.info(`Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload thumbnail: ${error.message}`);
    }
  }

  async applyVideoPackaging(videoId, packaging = {}, previousPackaging = null) {
    const title = String(packaging.title || '').trim();
    if (!videoId || !title || title.length > 100 || !packaging.thumbnailPath) {
      const error = new Error('A valid video ID, title, and thumbnail are required for a packaging change');
      error.status = 400;
      error.code = 'PACKAGING_INVALID';
      throw error;
    }
    const thumbnail = await fs.readFile(packaging.thumbnailPath);
    const current = await this.youtube.videos.list({ part: 'snippet', id: videoId });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) {
      const error = new Error(`YouTube video not found: ${videoId}`);
      error.status = 404;
      error.code = 'PACKAGING_VIDEO_NOT_FOUND';
      throw error;
    }

    const updateTitle = async nextTitle => this.youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: nextTitle,
          description: snippet.description || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '22',
          defaultLanguage: snippet.defaultLanguage,
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });

    await updateTitle(title);
    try {
      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnail }
      });
    } catch (error) {
      try {
        await updateTitle(String(previousPackaging?.title || snippet.title || '').trim());
      } catch (rollbackError) {
        error.message = `${error.message}; title rollback also failed: ${rollbackError.message}`;
      }
      throw error;
    }
    this.logger.info(`Applied approved growth-experiment packaging to video: ${videoId}`);
    return { videoId, title, thumbnailPath: packaging.thumbnailPath };
  }

  async uploadCaptions(videoId, captionsPath) {
    try {
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language: 'en',
            name: 'English Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    if (this.isProcessingQueue) {
      this.logger.info('Publish queue processing already in flight; skipping overlapping run.');
      return 0;
    }
    this.isProcessingQueue = true;
    try {
      const now = new Date();
      const scheduled = this.publishQueue
        .filter(entry => entry.status === 'scheduled')
        .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      const readyToPublish = scheduled.filter(entry => new Date(entry.publishTime) <= now);
      if (this.uploadPausedUntil && Date.now() < this.uploadPausedUntil) {
        this.logger.info('Publish queue paused until ' + new Date(this.uploadPausedUntil).toISOString() + ' (YouTube upload limit). ' + readyToPublish.length + ' item(s) waiting.');
        return 0;
      }

      if (readyToPublish.length === 0) {
        if (scheduled.length > 0) {
          this.logger.info(`Publish queue: ${scheduled.length} item(s) waiting, next publish at ${scheduled[0].publishTime}`);
        } else {
          this.logger.info('Publish queue is empty — nothing scheduled yet.');
        }
        return 0;
      }

      // Enforce persistent daily upload limit in audience timezone
      const tz = await getTimezone(this.db);
      const todayStr = getLocalDateString(now, tz);
      const dailyTarget = await getDailyTarget(this.db, 'youtube');
      let uploadedToday = 0;
      if (this.db.getAllRows) {
        const rows = await this.db.getAllRows(
          `SELECT published_at FROM publish_schedule
           WHERE status = 'published' AND published_at IS NOT NULL`
        ).catch(() => []);
        uploadedToday = (rows || []).filter(r => getLocalDateString(new Date(r.published_at), tz) === todayStr).length;
      }

      if (uploadedToday >= dailyTarget) {
        this.logger.info(`Daily YouTube upload limit reached (${uploadedToday}/${dailyTarget} for ${todayStr} [${tz}]). Remaining items stay scheduled.`);
        return 0;
      }

      const availableSlots = dailyTarget - uploadedToday;
      const batch = readyToPublish.slice(0, availableSlots);
      this.logger.info(`Processing publish queue: ${batch.length} item(s) to publish (Daily quota: ${uploadedToday}/${dailyTarget} in ${tz})...`);

      let publishedCount = 0;
      for (const entry of batch) {
        try {
          await this.publishContent(entry.productionId);
          this.logger.info(`Auto-published: ${entry.title}`);
          publishedCount++;
      } catch (error) {
        if (error.code === 'UPLOAD_DEFERRED') {
          this.logger.warn('Upload deferred, stays scheduled: ' + entry.title);
          if (this.uploadPausedUntil && Date.now() < this.uploadPausedUntil) break;
          continue;
        }
        if (error.code === 'READINESS_BLOCKED') {
          this.logger.warn(error.message);
          continue;
        }
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        if (error.code !== 'UPLOAD_OUTCOME_UNKNOWN') {
          entry.status = 'failed';
          entry.error = error.message;
          await this.db.updateScheduleEntry(entry);
        }
      }
    }
      
    return publishedCount;
  } finally {
      this.isProcessingQueue = false;
    }
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          entry.publishTime = betterTime.toISOString();
          await this.db.updateScheduleEntry(entry);
          this.logger.info(`Optimized publish time for: ${entry.title}`);
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);

    if (delayMinutes > 0) {
      const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId) ||
        await this.db.getLatestScheduleEntry?.(contentId);
      if (!entry) throw new Error(`Content not found: ${contentId}`);
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    }
    return this.publishContent(contentId, { publishNow: true });
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content paused: ${entry.title}`);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'scheduled';
    if (newPublishTime) {
      entry.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content resumed: ${entry.title}`);
    return entry;
  }

  async rescheduleContent(contentId, newPublishTime) {
    const publishTime = new Date(newPublishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) {
      const error = new Error('Choose a future publish time');
      error.status = 400;
      throw error;
    }
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`Content cannot be rescheduled while it is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    entry.publishTime = publishTime.toISOString();
    entry.status = 'scheduled';
    entry.error = null;
    await this.db.updateScheduleEntry(entry);
    if (!this.publishQueue.some(item => item.id === entry.id)) this.publishQueue.push(entry);
    this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    return entry;
  }

  async deleteScheduledContent(contentId) {
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`The schedule cannot be deleted while content is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    await this.db.deleteScheduleEntry(entry.id);
    this.publishQueue = this.publishQueue.filter(item => item.id !== entry.id);
    await this.syncShortStatus(entry, 'rendered');
    return entry;
  }
}

module.exports = { PublishingSchedulingAgent };
