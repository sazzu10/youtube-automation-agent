#!/usr/bin/env node
/**
 * Headless Cloud Automation Cycle for YouTube Shorts
 * Designed for phone-off execution via GitHub Actions (or local cron).
 * Priority: ₹0-cost, 6 Shorts/day, US audience scheduling (America/Los_Angeles),
 * strict quota limits, duplicate protection, safe recovery.
 */

require('dotenv').config();
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const {
  getTimezone,
  getLocalDateString,
  getDailyTarget
} = require('../utils/schedule-calculator');
const { Logger } = require('../utils/logger');

const logger = new Logger('CloudPipeline');

function resolvePipelineMode() {
  const eventName = (process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase();
  const inputMode = (process.env.INPUT_MODE || '').trim().toLowerCase();
  const inputDryRun = (process.env.INPUT_DRY_RUN || '').trim().toLowerCase();
  const scheduledLive = (process.env.SCHEDULED_LIVE_ENABLED || '').trim().toLowerCase() === 'true';
  const envDryRun = (process.env.DRY_RUN || '').trim().toLowerCase();
  const envMode = (process.env.PIPELINE_MODE || '').trim().toLowerCase();

  // Explicit env overrides (highest precedence)
  if (envMode === 'live' || envDryRun === 'false') {
    return { isDryRun: false, mode: 'live' };
  }
  if (envMode === 'dry-run' || envDryRun === 'true') {
    return { isDryRun: true, mode: 'dry-run' };
  }

  // Workflow dispatch trigger: check user inputs
  if (eventName === 'workflow_dispatch') {
    if (inputMode === 'live' || (inputMode !== 'dry-run' && inputDryRun === 'false')) {
      return { isDryRun: false, mode: 'live' };
    }
    return { isDryRun: true, mode: 'dry-run' };
  }

  // Scheduled cron trigger: requires explicit opt-in via SCHEDULED_LIVE_ENABLED secret
  if (eventName === 'schedule') {
    if (scheduledLive) {
      return { isDryRun: false, mode: 'live' };
    }
    return { isDryRun: true, mode: 'dry-run' };
  }

  // Safe default: dry-run
  return { isDryRun: true, mode: 'dry-run' };
}

async function runCloudPipelineCycle(options = {}) {
  const resolved = resolvePipelineMode();
  const isDryRun = typeof options.isDryRun === 'boolean' ? options.isDryRun : resolved.isDryRun;
  const mode = options.mode || (isDryRun ? 'dry-run' : 'live');
  logger.info(`=== Starting Cloud Pipeline Cycle (Mode: ${mode.toUpperCase()} | Dry Run: ${isDryRun}) ===`);

  // 1. Initialize Database
  const db = options.db || new Database();
  await db.initialize();

  // 2. Initialize Credentials
  const credentials = options.credentials || new CredentialManager();
  await credentials.initialize();

  // 3. Timezone and Quota settings
  const tz = await getTimezone(db, 'youtube');
  const dailyTarget = await getDailyTarget(db, 'youtube');
  const now = new Date();
  const todayStr = getLocalDateString(now, tz);

  logger.info(`Audience Timezone: ${tz} | Target: ${dailyTarget} videos/day | Date: ${todayStr}`);

  // 4. Validate credentials
  const hasAIText = credentials.hasAITextProvider();
  const hasYouTube = Boolean(credentials.credentials.youtube && credentials.tokens?.youtube);

  logger.info(`AI Provider Available: ${hasAIText} | YouTube API Configured: ${hasYouTube}`);

  if (!isDryRun && !hasAIText) {
    logger.error('FAIL-CLOSED: Live mode requires an AI Provider (GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY). Missing in GitHub Secrets.');
    return { status: 'FAILED', reason: 'NO_AI_PROVIDER' };
  }

  if (!isDryRun && !hasYouTube) {
    logger.error('FAIL-CLOSED: Live mode requires valid YouTube OAuth credentials (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN). Missing in GitHub Secrets.');
    return { status: 'FAILED', reason: 'MISSING_YOUTUBE_CREDENTIALS' };
  }

  // 5. Initialize Agents
  const agents = options.agents || {
    strategy: new ContentStrategyAgent(db, credentials),
    scriptWriter: new ScriptWriterAgent(db, credentials),
    thumbnailDesigner: new ThumbnailDesignerAgent(db, credentials),
    seoOptimizer: new SEOOptimizerAgent(db, credentials),
    production: new ProductionManagementAgent(db, credentials),
    publishing: hasYouTube ? new PublishingSchedulingAgent(db, credentials) : null
  };

  if (agents.strategy) {
    await agents.strategy.initialize().catch(err => {
      logger.warn(`Strategy agent initialization warning: ${err.message}`);
    });
  }

  if (!isDryRun) {
    if (!agents.publishing) {
      logger.error('FAIL-CLOSED: Publishing agent could not be instantiated in live mode.');
      return { status: 'FAILED', reason: 'PUBLISHING_AGENT_UNAVAILABLE' };
    }
    try {
      await agents.publishing.initialize();
    } catch (err) {
      logger.error(`FAIL-CLOSED: Publishing agent initialization failed: ${err.message}`);
      return { status: 'FAILED', reason: 'PUBLISHING_INITIALIZE_FAILED', error: err.message };
    }
  } else if (agents.publishing) {
    await agents.publishing.initialize().catch(err => {
      logger.warn(`Publishing agent initialization warning: ${err.message}`);
    });
  }

  // 6. Check existing uploads today to enforce daily cap (6/day)
  let uploadedToday = 0;
  if (db.getAllRows) {
    const rows = await db.getAllRows(
      `SELECT published_at FROM publish_schedule
       WHERE status = 'published' AND published_at IS NOT NULL`
    ).catch(() => []);
    uploadedToday = (rows || []).filter(r => getLocalDateString(new Date(r.published_at), tz) === todayStr).length;
  }

  logger.info(`Progress today: ${uploadedToday}/${dailyTarget} published on ${todayStr} [${tz}]`);

  if (uploadedToday >= dailyTarget && !isDryRun) {
    logger.info(`Daily upload limit reached (${uploadedToday}/${dailyTarget}). No additional videos will be uploaded today.`);
    return { status: 'COMPLETED', uploadedToday, dailyTarget, reason: 'DAILY_CAP_REACHED' };
  }

  // 7. Process pending publish queue if items are due
  let publishedCount = 0;
  if (agents.publishing && !isDryRun) {
    logger.info('Checking publish queue for due items...');
    publishedCount = await agents.publishing.processPublishQueue().catch(err => {
      logger.error(`Error processing publish queue: ${err.message}`);
      return 0;
    });
    logger.info(`Published from existing queue: ${publishedCount} video(s)`);
  }

  // Check again after publishing
  const remainingSlots = dailyTarget - (uploadedToday + publishedCount);
  if (remainingSlots <= 0 && !isDryRun) {
    logger.info(`Daily quota fulfilled (${uploadedToday + publishedCount}/${dailyTarget}).`);
    return { status: 'COMPLETED', publishedCount, remainingSlots: 0 };
  }

  // 8. Generate 1 video if daily generation is active
  const isGenerationEnabled = process.env.DAILY_CONTENT_GENERATION === 'on';
  if (!isGenerationEnabled) {
    logger.info('DAILY_CONTENT_GENERATION is off. Skipping content generation.');
    return { status: 'COMPLETED', publishedCount, generated: 0 };
  }

  logger.info(`Generating content for next available slot (${remainingSlots} slot(s) open today)...`);

  if (isDryRun) {
    logger.info('[DRY RUN] Simulating content generation cycle without API calls or live DB writes.');
    return { status: 'COMPLETED_DRY_RUN', publishedCount: 0, generated: 1 };
  }

  try {
    // Generate strategy
    const strategy = await agents.strategy.generateContentStrategy();
    logger.info(`Strategy: "${strategy.topic}" (${strategy.contentType || 'Shorts'})`);

    // Generate script
    const script = await agents.scriptWriter.generateScript(strategy);
    logger.info(`Script: "${script.title}"`);

    // Generate thumbnail
    const thumbnail = await agents.thumbnailDesigner.generateThumbnail(script);

    // Optimize SEO
    const seo = await agents.seoOptimizer.optimize(script, strategy);

    // Run production assembly
    const production = await agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo
    });
    logger.info(`Production complete: ${production.id}`);

    // Schedule content and immediately publish to YouTube in live cloud cycle
    if (!agents.publishing) {
      throw new Error('Publishing agent unavailable during live execution.');
    }

    const scheduleEntry = await agents.publishing.scheduleContent(production);
    if (!scheduleEntry) {
      throw new Error(`Failed to schedule production ${production.id} for publishing.`);
    }

    logger.info(`Content scheduled: ${scheduleEntry.id} (slot: ${scheduleEntry.publishTime})`);
    logger.info(`Live mode: dispatching upload to YouTube for production ${production.id}...`);

    const publishedResult = await agents.publishing.publishContent(scheduleEntry.productionId, { publishNow: true });

    if (!publishedResult || publishedResult.status !== 'published' || !publishedResult.youtubeId) {
      throw new Error(
        `YouTube upload failed: expected status 'published' and valid videoId, got status='${publishedResult?.status}', id='${publishedResult?.youtubeId}', error='${publishedResult?.error}'`
      );
    }

    publishedCount++;
    logger.info(`Successfully uploaded to YouTube: ${publishedResult.youtubeUrl || publishedResult.youtubeId}`);

    return {
      status: 'COMPLETED',
      publishedCount,
      generated: 1,
      videoId: publishedResult.youtubeId,
      videoUrl: publishedResult.youtubeUrl
    };
  } catch (genError) {
    logger.error(`Generation/publishing cycle encountered an error: ${genError.message}`);
    return { status: 'FAILED', error: genError.message };
  }
}

if (require.main === module) {
  runCloudPipelineCycle()
    .then(result => {
      logger.info(`Cycle result: ${JSON.stringify(result)}`);
      process.exit(result.status === 'FAILED' ? 1 : 0);
    })
    .catch(err => {
      logger.error(`Fatal cycle error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { runCloudPipelineCycle, resolvePipelineMode };
