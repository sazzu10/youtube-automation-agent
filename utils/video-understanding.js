const fs = require('fs');
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { computeFileContentHash } = require('./content-identity');
const { Logger } = require('./logger');

const CACHE_PATH = path.resolve('data/vidiq-video-ai-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Calculates adaptive, representative timestamp sample points across a video timeline.
 * Captures early, middle, and late/final-result frames.
 */
function calculateSampleTimestamps(duration) {
  const d = Math.max(0.5, Number(duration) || 0);

  if (d <= 2) {
    return [Number((d * 0.5).toFixed(2))];
  }
  if (d <= 6) {
    return [
      Number((d * 0.2).toFixed(2)),
      Number((d * 0.5).toFixed(2)),
      Number((d * 0.85).toFixed(2))
    ];
  }
  if (d <= 15) {
    return [
      1.0,
      Number((d * 0.35).toFixed(2)),
      Number((d * 0.65).toFixed(2)),
      Number(Math.max(1.5, d - 1.0).toFixed(2))
    ];
  }
  if (d <= 35) {
    return [
      1.5,
      Number((d * 0.25).toFixed(2)),
      Number((d * 0.50).toFixed(2)),
      Number((d * 0.75).toFixed(2)),
      Number(Math.max(2.0, d - 1.5).toFixed(2))
    ];
  }
  // Longer videos (>35s): 6 evenly distributed representative points
  return [
    2.0,
    Number((d * 0.20).toFixed(2)),
    Number((d * 0.40).toFixed(2)),
    Number((d * 0.60).toFixed(2)),
    Number((d * 0.80).toFixed(2)),
    Number(Math.max(2.0, d - 2.0).toFixed(2))
  ];
}

/**
 * Extracts representative frames using FFmpeg.
 * Operates sequentially and cleans up temporary files immediately to preserve Termux/Android resources.
 */
async function extractRepresentativeFrames(videoPath, { contentHash, logger = console } = {}) {
  const stat = fs.statSync(videoPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Video file does not exist or is empty: ${videoPath}`);
  }

  const duration = await getMediaDuration(videoPath);
  const timestamps = calculateSampleTimestamps(duration);
  const tempDir = path.resolve('temp', 'analysis_frames', `${contentHash.slice(0, 12)}_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const extractedFrames = [];

  try {
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const framePath = path.join(tempDir, `frame_${i + 1}.jpg`);

      // Sequential FFmpeg extraction: 720px width, even height, quality 3 (~80-120KB)
      // -ss before -i for fast input seeking without loading whole video in RAM
      const args = [
        '-ss', String(ts),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=720:-2',
        '-q:v', '3',
        '-y',
        framePath
      ];

      try {
        await runFFmpeg(args);
      } catch (ffErr) {
        logger.warn?.(`[VideoUnderstanding] Frame extraction at ${ts}s failed: ${ffErr.message}`);
        continue;
      }

      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
        const buffer = fs.readFileSync(framePath);
        extractedFrames.push({
          index: i + 1,
          timestamp: ts,
          base64: buffer.toString('base64'),
          size: buffer.length
        });
      }
    }

    if (extractedFrames.length === 0) {
      throw new Error(`FFmpeg failed to extract any valid frames from ${path.basename(videoPath)}`);
    }

    const totalKb = (extractedFrames.reduce((acc, f) => acc + f.size, 0) / 1024).toFixed(0);
    logger.info?.(
      `[VideoUnderstanding] Extracted ${extractedFrames.length} frames (duration: ${duration.toFixed(1)}s, total: ${totalKb} KB)`
    );

    return {
      duration,
      timestamps,
      frames: extractedFrames
    };
  } finally {
    // ALWAYS clean up temporary frames on Android
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * Safely parses the AI JSON response into the required structured schema.
 */
function parseVisualAnalysisJson(aiResponseText, logger = console) {
  if (!aiResponseText || typeof aiResponseText !== 'string') {
    throw new Error('Empty AI response received for video analysis');
  }

  let parsed = null;
  try {
    const text = String(aiResponseText || '').trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidates = fenceMatch ? [fenceMatch[1].trim()] : [];
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
          }
        }
      }
    }
    const greedy = text.match(/\{[\s\S]*\}/);
    if (greedy) candidates.push(greedy[0]);
    for (const c of candidates) {
      try { parsed = JSON.parse(c); if (parsed) break; } catch (_) {}
    }
  } catch (err) {
    logger.warn?.(`[VideoUnderstanding] JSON parse error: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Could not parse JSON from AI response: ${aiResponseText.slice(0, 150)}`);
  }

  const cleanArray = (val) => {
    if (!Array.isArray(val)) return [];
    return val
      .map(item => String(item || '').trim())
      .filter(item => item.length > 0 && !['null', 'none', 'unknown'].includes(item.toLowerCase()));
  };

  const cleanString = (val, fallback = null) => {
    if (val === null || val === undefined) return fallback;
    const str = String(val).trim();
    if (['null', 'unknown', 'none', 'n/a'].includes(str.toLowerCase())) {
      return fallback;
    }
    return str;
  };

  const visualKeywords = cleanArray(parsed.visual_keywords || parsed.keywords);
  const mainSubject = cleanString(parsed.main_subject || parsed.subject, 'Featured Subject');
  const objects = cleanArray(parsed.objects);
  const materials = cleanArray(parsed.materials);
  const tools = cleanArray(parsed.tools);
  const actions = cleanArray(parsed.actions);
  const process = cleanString(parsed.process, null);
  const transformation = cleanString(parsed.transformation, null);
  const finalResult = cleanString(parsed.final_result || parsed.finalResult, null);
  const environment = cleanString(parsed.environment, null);
  const visibleText = cleanArray(parsed.visible_text || parsed.visibleText);
  const category = cleanString(parsed.category, 'Entertainment');
  const summary = cleanString(
    parsed.summary,
    `${mainSubject} featured in a compelling video moment.`
  );
  const confidence = Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.9;

  return {
    visual_keywords: visualKeywords,
    main_subject: mainSubject,
    objects,
    materials,
    tools,
    actions,
    process,
    transformation,
    final_result: finalResult,
    environment,
    visible_text: visibleText,
    category,
    summary,
    confidence
  };
}

/**
 * Main entry point for video understanding:
 * Video file -> SHA-256 hash -> Cache check -> Frame extraction -> Gemini Multimodal -> Structured Analysis -> Cache
 */
async function analyzeVideoContent(videoPath, { aiTextService, db = null, logger = console, force = false, openRouterModel = 'google/gemini-2.5-flash' } = {}) {
  const contentHash = computeFileContentHash(videoPath);
  const fileName = path.basename(videoPath);
  const cache = loadCache();

  // 1. Check Cache
  const existing = cache[contentHash] || cache[fileName];
  if (!force && existing && existing.visualAnalysis && existing.visualAnalysis.summary) {
    logger.info?.(`[VideoUnderstanding] Cache HIT for content ${contentHash.slice(0, 12)} (${fileName})`);
    return existing.visualAnalysis;
  }

  logger.info?.(`[VideoUnderstanding] Analyzing real video frames for ${fileName} (${contentHash.slice(0, 12)})`);

  if (!aiTextService || typeof aiTextService.generateMultimodalContent !== 'function') {
    throw new Error('AI service with multimodal capability is required for video understanding');
  }

  // 2. Extract representative frames safely (Termux friendly)
  const { duration, timestamps, frames } = await extractRepresentativeFrames(videoPath, {
    contentHash,
    logger
  });

  // 3. Prepare Multimodal Parts
  const promptText = `You are an expert video analyst. Analyze these ${frames.length} representative sequential frames extracted from a real video across its ${duration.toFixed(1)}s timeline (timestamps: ${timestamps.map(t => `${t}s`).join(', ')}).
Analyze ONLY what is actually visible in the supplied frames. Do not guess or invent anything not visible.

Return ONLY a valid JSON object matching this EXACT schema:
{
  "visual_keywords": ["keyword1", "keyword2", "keyword3"],
  "main_subject": "Primary person, creature, object, or scene",
  "objects": ["object1", "object2"],
  "materials": ["material1"],
  "tools": ["tool1"],
  "actions": ["action1", "action2"],
  "process": "Description of the physical activity or progression shown across the frames",
  "transformation": "What changes from early to later frames (or null if static)",
  "final_result": "The final state, completed item, or outcome seen in the late frames",
  "environment": "Setting, lighting, indoor/outdoor backdrop",
  "visible_text": ["any on-screen text or captions visible"],
  "category": "Main topic/niche (e.g. Technology, Crafts, Cooking, Nature, Fitness, Art, Gaming)",
  "summary": "2-3 concise, factual sentences summarizing exactly what happens in the video.",
  "confidence": 0.95
}

RULES:
- Base your analysis STRICTLY on the visual content of the frames.
- If something (e.g. tools, visible_text, transformation) is not present or cannot be determined with confidence, use [] or null.
- Do NOT hallucinate brand names, real-world people identities, locations, or fake claims.
- Return ONLY the JSON object. No explanation or markdown outside the JSON.`;

  const parts = [
    ...frames.map(f => ({
      inlineData: {
        mimeType: 'image/jpeg',
        data: f.base64
      }
    })),
    { text: promptText }
  ];

  // 4. Send to Gemini Multimodal with Key Rotation & OpenRouter fallback
  const aiResponse = await aiTextService.generateMultimodalContent(parts, {
    openRouterModel: openRouterModel || 'google/gemini-2.5-flash',
    maxTokens: 1500,
    temperature: 0.2
  });

  // 5. Parse and Validate Structured Output
  const analysis = parseVisualAnalysisJson(aiResponse, logger);

  // 6. Cache Result
  const updatedCache = loadCache();
  updatedCache[contentHash] = {
    ...(updatedCache[contentHash] || {}),
    contentHash,
    fileName,
    duration,
    analyzedAt: new Date().toISOString(),
    visualAnalysis: analysis
  };
  saveCache(updatedCache);

  logger.info?.(
    `[VideoUnderstanding] Analysis completed for ${fileName}: Subject="${analysis.main_subject}", Category="${analysis.category}", Keywords=[${analysis.visual_keywords.slice(0, 5).join(', ')}]`
  );

  return analysis;
}

module.exports = {
  analyzeVideoContent,
  extractRepresentativeFrames,
  calculateSampleTimestamps,
  parseVisualAnalysisJson,
  loadCache,
  saveCache
};
