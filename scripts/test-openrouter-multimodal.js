#!/usr/bin/env node
/**
 * Safe Non-Publishing Test for OpenRouter Multimodal Video Understanding Fallback
 * Tests real frame extraction and OpenRouter vision analysis without publishing anything.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { extractRepresentativeFrames, parseVisualAnalysisJson } = require('../utils/video-understanding');
const { AITextService } = require('../utils/ai-text-service');

async function runTest() {
  console.log('====================================================');
  console.log('🧪 OPENROUTER MULTIMODAL FALLBACK TEST (NON-PUBLISHING)');
  console.log('====================================================\n');

  const testVideoPath = path.resolve('content/processing/inbox_39eb8d68d91ad066-ready.mp4');
  if (!fs.existsSync(testVideoPath)) {
    console.error(`❌ Test video not found at: ${testVideoPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(testVideoPath);
  console.log(`📹 Target Video: ${path.basename(testVideoPath)} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    console.error('❌ OPENROUTER_API_KEY is missing from environment / .env');
    process.exit(1);
  }
  console.log(`🔑 OpenRouter Key configured: ${openrouterKey.slice(0, 10)}...${openrouterKey.slice(-4)}`);

  console.log('\n[1/3] Extracting representative video frames using FFmpeg...');
  const t0 = Date.now();
  const { duration, timestamps, frames } = await extractRepresentativeFrames(testVideoPath, {
    contentHash: 'test_' + Date.now(),
    logger: console
  });
  console.log(`✅ Extracted ${frames.length} frames across ${duration.toFixed(1)}s (timestamps: ${timestamps.join('s, ')}s) in ${Date.now() - t0}ms`);

  console.log('\n[2/3] Initializing AITextService with forced OpenRouter fallback...');
  // google/gemini-2.5-flash: verified available on this OpenRouter account (gemini-2.0-flash-001 returned 404)
  const VISION_MODEL = 'google/gemini-2.5-flash';
  const aiService = new AITextService({
    aiProvider: {
      provider: 'openrouter',
      apiKey: openrouterKey,
      model: VISION_MODEL
    }
  });

  const promptText = `Analyze these ${frames.length} representative sequential frames extracted from a real video across its ${duration.toFixed(1)}s timeline.
Analyze ONLY what is actually visible in the supplied frames. Do not guess or invent anything not visible.

Return ONLY a valid JSON object matching this EXACT schema:
{
  "visual_keywords": ["keyword1", "keyword2", "keyword3"],
  "main_subject": "Primary person, creature, object, or scene",
  "objects": ["object1", "object2"],
  "materials": ["material1"],
  "tools": ["tool1"],
  "actions": ["action1", "action2"],
  "process": "Description of the physical activity shown across the frames",
  "transformation": "What changes from early to later frames (or null if static)",
  "final_result": "The final state, completed item, or outcome seen in the late frames",
  "environment": "Setting, lighting, indoor/outdoor backdrop",
  "visible_text": ["any on-screen text or captions visible"],
  "category": "Main topic/niche",
  "summary": "2-3 concise, factual sentences summarizing exactly what happens in the video.",
  "confidence": 0.95
}
RULES: Return ONLY the JSON object. No explanation or markdown outside the JSON.`;

  const parts = [
    ...frames.map(f => ({
      inlineData: {
        mimeType: 'image/jpeg',
        data: f.base64
      }
    })),
    { text: promptText }
  ];

  console.log(`\n[3/3] Calling OpenRouter multimodal analysis (maxTokens: 1500, model: ${VISION_MODEL})...`);
  const tApi = Date.now();
  let rawResponse;
  try {
    rawResponse = await aiService.generateMultimodalContent(parts, {
      openRouterModel: VISION_MODEL,
      maxTokens: 1500,
      temperature: 0.2
    });
    console.log(`✅ OpenRouter response received in ${Date.now() - tApi}ms`);
  } catch (apiErr) {
    console.error(`❌ OpenRouter call failed: ${apiErr.message}`);
    process.exit(1);
  }

  const analysis = parseVisualAnalysisJson(rawResponse, console);

  console.log('\n====================================================');
  console.log('📊 MULTIMODAL FRAME ANALYSIS RESULT');
  console.log('====================================================');
  console.log(`Main Subject:   ${analysis.main_subject}`);
  console.log(`Category:       ${analysis.category}`);
  console.log(`Summary:        ${analysis.summary}`);
  console.log(`Visual Keywords: ${analysis.visual_keywords?.join(', ')}`);
  console.log(`Objects:        ${analysis.objects?.join(', ')}`);
  console.log(`Actions:        ${analysis.actions?.join(', ')}`);
  console.log(`Confidence:     ${analysis.confidence}`);
  console.log('====================================================');
  console.log('🛡️  Safety check: No publishing performed. Database and queues 100% untouched.');
  console.log('====================================================\n');
}

runTest().catch(err => {
  console.error('Fatal error during test:', err);
  process.exit(1);
});
