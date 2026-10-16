const assert = require('assert');
const { resolvePipelineMode, runCloudPipelineCycle } = require('./cloud-pipeline-cycle');

async function testPipelineModes() {
  console.log('🧪 Starting Pipeline Mode & Safeguard Tests...\n');

  const originalEnv = { ...process.env };

  function resetEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
    delete process.env.DRY_RUN;
    delete process.env.PIPELINE_MODE;
    delete process.env.EVENT_NAME;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.INPUT_MODE;
    delete process.env.INPUT_DRY_RUN;
    delete process.env.SCHEDULED_LIVE_ENABLED;
  }

  // --- 1. Mode Resolution Unit Tests ---
  console.log('Test 1: Default environment defaults safely to dry-run');
  resetEnv();
  let res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, true, 'Default must be dry-run');
  assert.strictEqual(res.mode, 'dry-run');

  console.log('Test 2: Explicit DRY_RUN=false activates live mode');
  resetEnv();
  process.env.DRY_RUN = 'false';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, false, 'DRY_RUN=false must activate live mode');
  assert.strictEqual(res.mode, 'live');

  console.log('Test 3: Explicit PIPELINE_MODE=live activates live mode');
  resetEnv();
  process.env.PIPELINE_MODE = 'live';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, false, 'PIPELINE_MODE=live must activate live mode');
  assert.strictEqual(res.mode, 'live');

  console.log('Test 4: Workflow dispatch with mode=live');
  resetEnv();
  process.env.EVENT_NAME = 'workflow_dispatch';
  process.env.INPUT_MODE = 'live';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, false);
  assert.strictEqual(res.mode, 'live');

  console.log('Test 5: Workflow dispatch with mode=dry-run');
  resetEnv();
  process.env.EVENT_NAME = 'workflow_dispatch';
  process.env.INPUT_MODE = 'dry-run';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, true);
  assert.strictEqual(res.mode, 'dry-run');

  console.log('Test 6: Workflow dispatch with legacy dry_run=false');
  resetEnv();
  process.env.EVENT_NAME = 'workflow_dispatch';
  process.env.INPUT_DRY_RUN = 'false';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, false);
  assert.strictEqual(res.mode, 'live');

  console.log('Test 7: Scheduled run without SCHEDULED_LIVE_ENABLED defaults to dry-run');
  resetEnv();
  process.env.EVENT_NAME = 'schedule';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, true);
  assert.strictEqual(res.mode, 'dry-run');

  console.log('Test 8: Scheduled run with SCHEDULED_LIVE_ENABLED=true activates live mode');
  resetEnv();
  process.env.EVENT_NAME = 'schedule';
  process.env.SCHEDULED_LIVE_ENABLED = 'true';
  res = resolvePipelineMode();
  assert.strictEqual(res.isDryRun, false);
  assert.strictEqual(res.mode, 'live');

  // --- 2. Cloud Pipeline Cycle Integration Tests ---
  console.log('\nTest 9: runCloudPipelineCycle in dry-run mode completes safely');
  resetEnv();
  process.env.DRY_RUN = 'true';
  const dryRunResult = await runCloudPipelineCycle();
  assert.strictEqual(dryRunResult.status, 'COMPLETED_DRY_RUN');
  assert.strictEqual(dryRunResult.publishedCount, 0);
  assert.strictEqual(dryRunResult.generated, 1);

  console.log('\nTest 10: runCloudPipelineCycle fails closed in live mode when YouTube credentials missing');
  resetEnv();
  process.env.DRY_RUN = 'false';
  process.env.PIPELINE_MODE = 'live';

  const mockCredsNoYt = {
    initialize: async () => true,
    hasAITextProvider: () => true,
    credentials: {},
    tokens: {}
  };

  const liveNoYtResult = await runCloudPipelineCycle({ credentials: mockCredsNoYt });
  assert.strictEqual(liveNoYtResult.status, 'FAILED');
  assert.strictEqual(liveNoYtResult.reason, 'MISSING_YOUTUBE_CREDENTIALS');

  console.log('\nTest 11: runCloudPipelineCycle fails closed in live mode when AI credentials missing');
  resetEnv();
  process.env.DRY_RUN = 'false';
  process.env.PIPELINE_MODE = 'live';

  const mockCredsNoAi = {
    initialize: async () => true,
    hasAITextProvider: () => false,
    credentials: { youtube: { client_id: 'mock' } },
    tokens: { youtube: { refresh_token: 'mock' } }
  };

  const liveNoAiResult = await runCloudPipelineCycle({ credentials: mockCredsNoAi });
  assert.strictEqual(liveNoAiResult.status, 'FAILED');
  assert.strictEqual(liveNoAiResult.reason, 'NO_AI_PROVIDER');

  console.log('\nTest 12: Live mode reaches publishContent with publishNow: true and returns video ID');
  resetEnv();
  process.env.DRY_RUN = 'false';
  process.env.PIPELINE_MODE = 'live';

  const mockCredsValid = {
    initialize: async () => true,
    hasAITextProvider: () => true,
    credentials: { youtube: { client_id: 'mock_id', client_secret: 'mock_secret' } },
    tokens: { youtube: { refresh_token: 'mock_refresh' } }
  };

  const mockDb = {
    initialize: async () => true,
    getAllRows: async () => [],
    getSetting: async () => null,
    updateScheduleEntry: async (entry) => entry,
    saveScheduleEntry: async (entry) => entry,
    getLatestScheduleEntry: async () => null
  };

  let publishContentCalledWith = null;

  const mockAgentsSuccess = {
    strategy: {
      initialize: async () => true,
      generateContentStrategy: async () => ({ topic: 'Test Topic', contentType: 'Shorts' })
    },
    scriptWriter: {
      generateScript: async () => ({ title: 'Test Title' })
    },
    thumbnailDesigner: {
      generateThumbnail: async () => ({ path: '/tmp/test_thumb.jpg' })
    },
    seoOptimizer: {
      optimize: async () => ({ title: 'Test Title', tags: ['test'] })
    },
    production: {
      processContent: async () => ({ id: 'prod_test_123' })
    },
    publishing: {
      initialize: async () => true,
      processPublishQueue: async () => 0,
      scheduleContent: async (prod) => ({ id: 'sched_123', productionId: prod.id, publishTime: new Date().toISOString() }),
      publishContent: async (prodId, opts) => {
        publishContentCalledWith = { prodId, opts };
        return {
          status: 'published',
          youtubeId: 'yt_mock_video_999',
          youtubeUrl: 'https://www.youtube.com/watch?v=yt_mock_video_999'
        };
      }
    }
  };

  const liveSuccessResult = await runCloudPipelineCycle({
    credentials: mockCredsValid,
    db: mockDb,
    agents: mockAgentsSuccess
  });

  assert.strictEqual(liveSuccessResult.status, 'COMPLETED');
  assert.strictEqual(liveSuccessResult.publishedCount, 1);
  assert.strictEqual(liveSuccessResult.videoId, 'yt_mock_video_999');
  assert.deepStrictEqual(publishContentCalledWith, { prodId: 'prod_test_123', opts: { publishNow: true } });

  console.log('\nTest 13: Live mode fails closed if publishContent fails to publish');
  resetEnv();
  process.env.DRY_RUN = 'false';
  process.env.PIPELINE_MODE = 'live';

  const mockAgentsFail = {
    ...mockAgentsSuccess,
    publishing: {
      initialize: async () => true,
      processPublishQueue: async () => 0,
      scheduleContent: async (prod) => ({ id: 'sched_124', productionId: prod.id, publishTime: new Date().toISOString() }),
      publishContent: async () => {
        throw new Error('Simulated YouTube API Upload Failure');
      }
    }
  };

  const liveFailResult = await runCloudPipelineCycle({
    credentials: mockCredsValid,
    db: mockDb,
    agents: mockAgentsFail
  });

  assert.strictEqual(liveFailResult.status, 'FAILED');
  assert(liveFailResult.error.includes('Simulated YouTube API Upload Failure'));

  console.log('\nTest 14: Ephemeral clean runner directory creation verifies all required directories exist');
  const fs = require('fs').promises;
  const path = require('path');
  const checkDirs = [
    'uploads',
    'uploads/thumbnails',
    'uploads/videos',
    'data',
    'data/production',
    'data/assets',
    'data/videos',
    'data/audio',
    'data/scripts',
    'data/captions',
    'temp/processing',
    'logs'
  ];
  for (const d of checkDirs) {
    const fullPath = path.resolve(process.cwd(), d);
    const stat = await fs.stat(fullPath).catch(() => null);
    assert(stat && stat.isDirectory(), `Directory ${d} must exist after pipeline run`);
  }

  console.log('\nTest 15: AI script parser robustness with malformed / markdown JSON and template fallback');
  const { ScriptWriterAgent } = require('../agents/script-writer-agent');
  const dummyScriptWriter = new ScriptWriterAgent(mockDb, mockCredsValid);

  // Case 15a: Markdown code fence extraction
  const jsonWithFence = '```json\n{"title": "Markdown Title", "hook": "Look at this", "scenes": [{"text": "Hello"}]}\n```';
  const parsedFence = dummyScriptWriter.parseAIJsonResponse(jsonWithFence, { topic: 'Test' });
  assert.strictEqual(parsedFence.title, 'Markdown Title');

  // Case 15b: Malformed text fallback
  const malformedText = 'I cannot generate JSON right now, sorry!';
  const parsedFallback = dummyScriptWriter.parseAIJsonResponse(malformedText, { topic: 'Fallback Topic' });
  assert(parsedFallback.title && parsedFallback.title.length > 0, 'Must produce a valid title from fallback');
  assert(Array.isArray(parsedFallback.scenes) && parsedFallback.scenes.length > 0, 'Must produce fallback scenes');
  assert(parsedFallback.narration && parsedFallback.narration.length > 0, 'Must produce fallback narration');

  console.log('\nTest 16: YouTube upload fails closed if API returns no valid video ID');
  const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
  const publishingAgent = new PublishingSchedulingAgent(mockDb, mockCredsValid);
  publishingAgent.youtube = {
    videos: {
      insert: async () => ({ data: { /* Missing id */ } })
    }
  };
  // Mock dummy MP4 file for getVideoStream
  const testMp4Path = path.resolve(process.cwd(), 'temp/test_sample_video.mp4');
  await fs.writeFile(testMp4Path, Buffer.from('fake_mp4_bytes_for_test'));

  const dummyScheduleEntry = {
    id: 'test_sched_no_id',
    metadata: {
      seo: { title: 'Test Video', description: 'Test Desc', tags: ['shorts'] },
      video: { path: testMp4Path }
    }
  };

  let noIdThrew = false;
  try {
    await publishingAgent.uploadToYouTube(dummyScheduleEntry, { publishNow: true });
  } catch (err) {
    noIdThrew = true;
    assert(err.message.includes('returned no valid video ID'), `Expected no valid video ID error, got: ${err.message}`);
  }
  assert.strictEqual(noIdThrew, true, 'Must fail closed when video ID is missing from response');

  console.log('\nTest 17: Upload uncertain outcome sets status to reconciliation_required and throws UPLOAD_OUTCOME_UNKNOWN');
  publishingAgent.youtube.videos.insert = async () => {
    const err = new Error('500 Internal Server Error from YouTube');
    err.status = 500;
    throw err;
  };

  dummyScheduleEntry.productionId = 'prod_test_uncertain';
  dummyScheduleEntry.metadata.audio = { path: testMp4Path };
  publishingAgent.publishQueue = [dummyScheduleEntry];

  let uncertainThrew = false;
  try {
    await publishingAgent.publishContent('prod_test_uncertain');
  } catch (err) {
    uncertainThrew = true;
    assert.strictEqual(err.code, 'UPLOAD_OUTCOME_UNKNOWN', 'Error code must be UPLOAD_OUTCOME_UNKNOWN');
    assert.strictEqual(dummyScheduleEntry.status, 'reconciliation_required', 'Schedule entry must be marked reconciliation_required');
  }
  assert.strictEqual(uncertainThrew, true, 'Must throw UPLOAD_OUTCOME_UNKNOWN on uncertain 500 response');

  console.log('\nTest 18: Live mode quota reconciliation halts cycle when channel has 6 uploads today');
  resetEnv();
  process.env.DRY_RUN = 'false';
  process.env.PIPELINE_MODE = 'live';

  const mockPublishingWith6Uploads = {
    initialize: async () => true,
    getChannelUploadsCountToday: async () => ({ count: 6, items: [1,2,3,4,5,6] }),
    processPublishQueue: async () => 0,
    scheduleContent: async () => null,
    publishContent: async () => null
  };

  const quotaResult = await runCloudPipelineCycle({
    credentials: mockCredsValid,
    db: {
      initialize: async () => true,
      getAllRows: async () => [] // Local DB is empty (simulating clean runner with evicted cache)
    },
    agents: {
      ...mockAgentsSuccess,
      publishing: mockPublishingWith6Uploads
    }
  });

  assert.strictEqual(quotaResult.status, 'COMPLETED');
  assert.strictEqual(quotaResult.reason, 'DAILY_CAP_REACHED');
  assert.strictEqual(quotaResult.uploadedToday, 6);

  // Clean up test file
  await fs.unlink(testMp4Path).catch(() => {});

  // Restore env
  resetEnv();
  console.log('\n✅ ALL 18 TESTS PASSED SUCCESSFULLY!');
}

if (require.main === module) {
  testPipelineModes()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Test failed:', err);
      process.exit(1);
    });
}

module.exports = { testPipelineModes };

