#!/usr/bin/env node
/**
 * Safe Scheduled Publishing Tool for Existing Unlisted YouTube Shorts
 *
 * Distributes up to 6 Shorts across peak US audience windows (America/Los_Angeles),
 * sets each video's status.publishAt with status.privacyStatus='private' (YouTube requirement),
 * and persists the video's ID, time, and status to SQLite publish_schedule.
 *
 * Default is DRY-RUN (safe simulation).
 * Pass --live to execute real scheduling on YouTube.
 */

require('dotenv').config();
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const {
  getTimezone,
  getLocalDateString,
  getDailySlotsForDate,
  distributeVideosAcrossSlots
} = require('../utils/schedule-calculator');
const { Logger } = require('../utils/logger');

const logger = new Logger('ScheduleUnlisted');

async function scheduleUnlistedVideos(options = {}) {
  let isDryRun = true;
  if (options.dryRun === false || options.isDryRun === false || options.live === true || process.argv.includes('--live')) {
    isDryRun = false;
  } else if (options.dryRun === true || options.isDryRun === true) {
    isDryRun = true;
  } else if (process.env.DRY_RUN === 'false' || process.env.PIPELINE_MODE === 'live') {
    isDryRun = false;
  }
  const isLive = !isDryRun;
  const targetDateInput = options.date || process.argv.find(a => a.startsWith('--date='))?.split('=')[1] || null;

  logger.info(`=== YouTube Scheduled Publishing Manager ===`);
  logger.info(`Mode: ${isDryRun ? 'DRY-RUN (Safe Simulation - No live changes)' : 'LIVE (Will update YouTube status)'}`);

  const db = options.db || new Database();
  await db.initialize();

  const credentials = options.credentials || new CredentialManager();
  await credentials.initialize();

  const timezone = options.timezone || (await getTimezone(db, 'youtube'));
  logger.info(`Audience Timezone: ${timezone}`);

  const publishingAgent = options.publishingAgent || new PublishingSchedulingAgent(db, credentials, { isDryRun });
  if (publishingAgent.initialize) {
    await publishingAgent.initialize().catch(err => {
      logger.warn(`Publishing agent initialization: ${err.message}`);
    });
  }

  // 1. Resolve videos to schedule
  // Priority: options.videos -> unlisted videos from YouTube channel -> recent uploads from publish_schedule
  let candidates = [];

  if (Array.isArray(options.videos) && options.videos.length > 0) {
    candidates = options.videos;
  } else if (!isDryRun && publishingAgent.youtube) {
    logger.info('Fetching recent channel videos from YouTube API...');
    const recentVideos = await publishingAgent.getChannelRecentVideos(10);
    // Find videos that are unlisted or private and not yet scheduled
    candidates = recentVideos.filter(v => v.privacyStatus === 'unlisted' || (v.privacyStatus === 'private' && !v.publishAt));
    logger.info(`Found ${candidates.length} unlisted/unscheduled video(s) on YouTube channel.`);
  }

  // Fallback to recent local DB entries with youtube_id
  if (candidates.length === 0 && db.getAllRows) {
    logger.info('Looking for recent uploaded videos in local publish_schedule...');
    const rows = await db.getAllRows(
      `SELECT id, production_id, title, publish_time, status, youtube_id, youtube_url, published_at, metadata
       FROM publish_schedule
       WHERE youtube_id IS NOT NULL AND status IN ('published', 'uploaded', 'scheduled')
       ORDER BY created_at DESC LIMIT 6`
    ).catch(() => []);

    candidates = (rows || []).map(r => ({
      id: r.youtube_id,
      title: r.title,
      productionId: r.production_id,
      scheduleId: r.id,
      currentStatus: r.status,
      publishTime: r.publish_time
    }));
    logger.info(`Found ${candidates.length} candidate video(s) in local database.`);
  }

  if (candidates.length === 0) {
    logger.warn('No candidate videos found to schedule.');
    return { status: 'NO_VIDEOS', scheduledCount: 0, results: [] };
  }

  const videosToSchedule = candidates.slice(0, 6);
  logger.info(`Processing ${videosToSchedule.length} video(s)...`);

  // 2. Calculate distribution slots in America/Los_Angeles
  let slots = [];
  if (targetDateInput) {
    slots = getDailySlotsForDate(targetDateInput, timezone, 'youtube');
  } else {
    // If scheduling today has open slots in the future, distribute; otherwise roll to tomorrow
    const now = new Date();
    slots = await distributeVideosAcrossSlots({
      count: videosToSchedule.length,
      now,
      timezone,
      platform: 'youtube',
      // If today is already past peak windows or full, default starting date can be tomorrow
      startDate: options.startDate || null
    });
  }

  logger.info(`Target distribution slots (${timezone}):`);
  slots.forEach((s, i) => {
    const d = new Date(s);
    const localStr = d.toLocaleString('en-US', { timeZone: timezone, hour12: true });
    logger.info(`  Slot ${i + 1}: ${s} (Local: ${localStr})`);
  });

  // 3. Schedule each video
  const results = [];
  for (let i = 0; i < videosToSchedule.length; i++) {
    const video = videosToSchedule[i];
    const videoId = video.id || video.youtube_id;
    const slot = slots[i];

    if (!slot) {
      logger.warn(`No slot available for video ${videoId}, skipping.`);
      continue;
    }

    const localTimeStr = new Date(slot).toLocaleString('en-US', { timeZone: timezone, hour12: true });
    logger.info(`\n[${i + 1}/${videosToSchedule.length}] Video: "${video.title || videoId}" (ID: ${videoId})`);
    logger.info(`  Target Slot: ${slot} [${localTimeStr} ${timezone}]`);

    try {
      const scheduleResult = await publishingAgent.scheduleUploadedVideo(videoId, slot, {
        dryRun: isDryRun,
        productionId: video.productionId,
        title: video.title
      });

      results.push({
        videoId,
        title: video.title,
        publishAt: slot,
        localTime: localTimeStr,
        status: scheduleResult.status,
        simulated: isDryRun,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
      });

      logger.info(`  Result: ${scheduleResult.status.toUpperCase()} ${isDryRun ? '(simulated)' : ''}`);
    } catch (err) {
      logger.error(`  Failed to schedule ${videoId}: ${err.message}`);
      results.push({
        videoId,
        title: video.title,
        publishAt: slot,
        status: 'failed',
        error: err.message
      });
    }
  }

  const successCount = results.filter(r => r.status === 'scheduled').length;
  logger.info(`\n=== Summary: ${successCount}/${videosToSchedule.length} video(s) ${isDryRun ? 'simulated for scheduling' : 'scheduled on YouTube'} ===`);

  return {
    status: 'COMPLETED',
    mode: isDryRun ? 'dry-run' : 'live',
    scheduledCount: successCount,
    results
  };
}

if (require.main === module) {
  scheduleUnlistedVideos()
    .then(res => {
      console.log('\nExecution Output:', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch(err => {
      logger.error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { scheduleUnlistedVideos };
