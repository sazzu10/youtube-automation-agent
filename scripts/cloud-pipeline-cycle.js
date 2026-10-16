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

async function runCloudPipelineCycle() {
  const isDryRun = process.env.DRY_RUN === 'true';
  logger.info(`=== Starting Cloud Pipeline Cycle (Dry Run: ${isDryRun}) ===`);

  // 1. Initialize Database
  const db = new Database();
  await db.initialize();

  // 2. Initialize Credentials
  const credentials = new CredentialManager();
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

  if (!hasAIText && !isDryRun) {
    logger.warn('No AI Provider configured. Cloud run requires GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in GitHub Secrets.');
    return { status: 'SKIPPED', reason: 'NO_AI_PROVIDER' };
  }

  // 5. Initialize Agents
  const agents = {
    strategy: new ContentStrategyAgent(db, credentials),
    scriptWriter: new ScriptWriterAgent(db, credentials),
    thumbnailDesigner: new ThumbnailDesignerAgent(db, credentials),
    seoOptimizer: new SEOOptimizerAgent(db, credentials),
    production: new ProductionManagementAgent(db, credentials),
    publishing: hasYouTube ? new PublishingSchedulingAgent(db, credentials) : null
  };

  if (agents.publishing) {
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

  if (uploadedToday >= dailyTarget) {
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
  if (remainingSlots <= 0) {
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

    // Schedule content
    if (agents.publishing) {
      const scheduleEntry = await agents.publishing.scheduleContent(production);
      if (scheduleEntry) {
        logger.info(`Content scheduled for: ${scheduleEntry.publishTime}`);

        // If the scheduled time is due right now (or within 5 minutes), attempt upload
        const scheduleTime = new Date(scheduleEntry.publishTime).getTime();
        if (scheduleTime <= Date.now() + 5 * 60 * 1000) {
          logger.info('Scheduled slot is due now; dispatching to YouTube...');
          await agents.publishing.processPublishQueue();
        }
      }
    }

    return { status: 'COMPLETED', publishedCount, generated: 1 };
  } catch (genError) {
    logger.error(`Generation cycle encountered an error: ${genError.message}`);
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

module.exports = { runCloudPipelineCycle };
