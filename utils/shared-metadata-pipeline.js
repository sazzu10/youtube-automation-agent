const fs = require('fs');
const path = require('path');
const { computeFileContentHash } = require('./content-identity');
const { analyzeVideoContent } = require('./video-understanding');

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
 * Sanitizes base filename to human-friendly topic (used only as secondary fallback).
 */
function cleanTopicFromFileName(fileName) {
  const base = path.basename(fileName, path.extname(fileName))
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(download|vid|video|output|final|test|processed|clip)\b/gi, '')
    .replace(/\d{8,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return base || 'Engaging Video Moment';
}

const YOUTUBE_CATEGORY_MAP = {
  'tech': '28',
  'technology': '28',
  'science': '28',
  'gadgets': '28',
  'electronics': '28',
  'circuit': '28',
  'education': '27',
  'educational': '27',
  'learning': '27',
  'tutorial': '26',
  'how-to': '26',
  'howto': '26',
  'style': '26',
  'diy': '26',
  'craft': '26',
  'crafts': '26',
  'art': '26',
  'woodworking': '26',
  'metalworking': '26',
  'welding': '26',
  'machining': '26',
  'fabrication': '26',
  'gaming': '20',
  'gameplay': '20',
  'game': '20',
  'arcade': '20',
  'entertainment': '24',
  'comedy': '23',
  'humor': '23',
  'music': '10',
  'news': '25',
  'politics': '25',
  'sports': '17',
  'autos': '2',
  'vehicles': '2',
  'cars': '2',
  'pets': '15',
  'animals': '15',
  'travel': '19',
  'events': '19',
  'people': '22',
  'blogs': '22'
};

function resolveYouTubeCategoryId(categoryInput) {
  if (!categoryInput) return '22';
  let lower = '';
  if (typeof categoryInput === 'string') {
    lower = categoryInput.trim().toLowerCase();
  } else if (typeof categoryInput === 'object') {
    lower = [categoryInput.category, categoryInput.topic, categoryInput.main_subject, categoryInput.subject]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }
  for (const [key, id] of Object.entries(YOUTUBE_CATEGORY_MAP)) {
    if (lower.includes(key)) return id;
  }
  return '22';
}

/**
 * Safe deterministic fallback when AI is unavailable.
 */
function buildSafeDeterministicMetadata(topic, visualAnalysis = null, isVisualSuccess = false) {
  const cleanTopic = topic || 'Engaging Video Moment';
  const words = cleanTopic.split(/\s+/).filter(w => w.length > 2);
  const title = `${cleanTopic} #Shorts`.slice(0, 100);

  const keywords = visualAnalysis?.visual_keywords?.length
    ? visualAnalysis.visual_keywords
    : words;

  const hashtags = [
    '#Shorts',
    '#Reels',
    ...keywords.map(w => `#${w.replace(/[^a-zA-Z0-9]/g, '')}`).filter(t => t.length > 2)
  ].slice(0, 8);

  const summary = visualAnalysis?.summary || `A featured short video focusing on ${cleanTopic}.`;
  const igCaption = `${cleanTopic} ✨\n\n${summary}\n\n${hashtags.join(' ')}`;
  const ytDescription = `${cleanTopic} ✨\n\n${summary}\n\n${hashtags.slice(0, 3).join(' ')}`;
  const tags = [...new Set([...keywords, cleanTopic, 'shorts', 'reels'])].slice(0, 15);
  const seoStatus = isVisualSuccess ? 'ready' : 'needs_review';
  const categoryId = resolveYouTubeCategoryId(visualAnalysis?.category);

  return {
    coreUnderstanding: {
      topic: cleanTopic,
      hook: `Watch ${cleanTopic}`,
      summary,
      category: visualAnalysis?.category || 'Entertainment',
      audience: 'US & Global Audience',
      visualAnalysis,
      visualAnalysisSuccess: isVisualSuccess
    },
    instagram: {
      title,
      caption: igCaption,
      hashtags,
      cta: 'Follow for more daily content!',
      overallScore: isVisualSuccess ? 80 : 40,
      seoStatus
    },
    youtube: {
      title,
      description: ytDescription,
      hashtags: hashtags.slice(0, 4),
      tags,
      categoryId,
      seoStatus
    }
  };
}

/**
 * Shared metadata pipeline:
 * Takes video file path -> Computes Content Hash -> Checks Cache ->
 * Extracts Representative Frames -> Gemini Multimodal Analysis ->
 * Obtains Structured Visual Analysis -> Caches Result -> Passes onward to metadata formatting.
 */
async function processSharedVideoMetadata(filePath, { aiTextService, db, logger = console, force = false } = {}) {
  const contentHash = computeFileContentHash(filePath);
  const fileName = path.basename(filePath);
  const cache = loadCache();

  // 1. Check existing cache
  const existing = cache[contentHash] || cache[fileName];
  if (!force && existing && existing.instagram && existing.youtube && existing.visualAnalysis) {
    logger.info?.(`[Shared Metadata] Cache HIT for content ${contentHash.slice(0, 12)} (${fileName})`);
    return {
      contentHash,
      coreUnderstanding: existing.coreUnderstanding || existing.understanding || {},
      visualAnalysis: existing.visualAnalysis,
      instagram: existing.instagram,
      youtube: existing.youtube,
      cached: true
    };
  }

  logger.info?.(`[Shared Metadata] Starting video understanding pipeline for ${fileName} (${contentHash.slice(0, 12)})`);

  // 2. Multimodal Video Understanding (real visual frame extraction and analysis)
  let visualAnalysis = (!force && existing?.visualAnalysis) ? existing.visualAnalysis : null;
  let visualAnalysisError = null;

  if (!visualAnalysis) {
    try {
      visualAnalysis = await analyzeVideoContent(filePath, {
        aiTextService,
        db,
        logger,
        force
      });
    } catch (vuErr) {
      visualAnalysisError = vuErr.message;
      logger.warn?.(`[Shared Metadata] Visual analysis failed: ${vuErr.message}; marking video for retry/review`);
    }
  }

  const visualAnalysisSuccess = Boolean(visualAnalysis && visualAnalysis.main_subject);

  // 3. Derive primary subject from visual understanding (or filename fallback if visual failed)
  const cleanTopicFallback = cleanTopicFromFileName(fileName);
  const primaryTopic = visualAnalysis?.main_subject || cleanTopicFallback;
  const primarySummary = visualAnalysis?.summary || `A featured video moment focusing on ${primaryTopic}.`;
  const primaryKeywords = visualAnalysis?.visual_keywords || [];

  const coreUnderstanding = {
    topic: primaryTopic,
    hook: visualAnalysis?.summary || `Watch ${primaryTopic}`,
    summary: primarySummary,
    category: visualAnalysis?.category || 'Entertainment',
    audience: 'General Audience',
    visualKeywords: primaryKeywords,
    actions: visualAnalysis?.actions || [],
    finalResult: visualAnalysis?.final_result || null,
    visualAnalysis: visualAnalysis || null,
    visualAnalysisSuccess
  };

  let generated = null;

  // 4. Formulate metadata using real visual understanding
  if (aiTextService && typeof aiTextService.generateText === 'function') {
    try {
      const prompt = `You are an expert social media and YouTube SEO growth strategist for US and English-speaking audiences.
Create unified, high-performing publishing metadata for this video based STRICTLY on its actual visual analysis.

VISUAL CONTENT SUMMARY: "${primarySummary}"
PRIMARY VISUAL SUBJECT: "${primaryTopic}"
VISUAL KEYWORDS OBSERVED: "${primaryKeywords.join(', ')}"
ACTIONS OBSERVED: "${(visualAnalysis?.actions || []).join(', ')}"
FINAL RESULT SHOWN: "${visualAnalysis?.final_result || 'N/A'}"
CATEGORY: "${coreUnderstanding.category}"
FILE NAME: "${fileName}"

Return ONLY a valid JSON object matching this exact schema:
{
  "coreUnderstanding": {
    "topic": "Concise main topic reflecting visual reality",
    "hook": "1-sentence conversational hook tuned for US viewers",
    "summary": "1-2 sentence description of what the video shows",
    "category": "Main content category",
    "audience": "US & global interested viewers"
  },
  "instagram": {
    "caption": "High-converting Instagram Reels caption with hook line, linebreaks, and emojis based on the visual action",
    "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8"],
    "cta": "Specific engaging CTA"
  },
  "youtube": {
    "title": "Compelling, natural YouTube title (under 90 chars, Title Case, no clickbait)",
    "description": "Engaging description with context, viewer takeaway, and natural keywords",
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10"]
  }
}

STRICT SEO & AUDIENCE RULES:
- Tailor language, tone, and references naturally for a US / American creator audience.
- Ground title and description strictly in the real visual subject ("${primaryTopic}").
- Title must be under 90 characters and describe what actually happens or what is created.
- Never output generic placeholder titles like "Amazing Video", "Engaging Moment", or "Video #Shorts".
- Description must give genuine context in 2-3 readable sentences without fake claims, fake statistics, or misleading hype.
- Use 8-12 highly relevant tags matching the visual action, materials, tools, and subject.
- No spammy keyword stuffing.`;

      const responseText = await aiTextService.generateText(prompt, { maxTokens: 900, temperature: 0.7 });
      let parsed = null;
      try {
        const text = String(responseText || '').trim();
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
      } catch (_) {}
      if (parsed) {
        if (parsed.instagram && parsed.youtube) {
          const igTags = [...new Set(
            (Array.isArray(parsed.instagram.hashtags) ? parsed.instagram.hashtags : [])
              .map(t => `#${String(t).replace(/^#+/, '').replace(/[^a-zA-Z0-9_]/g, '')}`)
              .filter(t => t.length > 2)
          )].slice(0, 10);

          let igCaption = String(parsed.instagram.caption || '').trim();
          if (igTags.length && !igCaption.includes(igTags[0])) {
            igCaption = `${igCaption}\n\n${igTags.join(' ')}`;
          }
          if (parsed.instagram.cta && !igCaption.includes(parsed.instagram.cta)) {
            igCaption = `${igCaption}\n\n${parsed.instagram.cta}`;
          }

          const ytTitle = String(parsed.youtube.title || `${primaryTopic} #Shorts`).trim().slice(0, 98);
          const ytTags = (Array.isArray(parsed.youtube.tags) ? parsed.youtube.tags : primaryKeywords).slice(0, 15);
          const ytHashtags = (Array.isArray(parsed.youtube.hashtags) ? parsed.youtube.hashtags : ['#Shorts'])
            .map(t => `#${String(t).replace(/^#+/, '')}`)
            .slice(0, 4);

          const finalCat = parsed.coreUnderstanding?.category || coreUnderstanding.category || visualAnalysis?.category;
          const dynamicCategoryId = resolveYouTubeCategoryId(finalCat);

          generated = {
            coreUnderstanding: {
              ...coreUnderstanding,
              ...(parsed.coreUnderstanding || {})
            },
            visualAnalysis,
            instagram: {
              title: `${primaryTopic} #Shorts`.slice(0, 100),
              caption: igCaption,
              hashtags: igTags.length ? igTags : ['#Shorts', '#Reels'],
              cta: parsed.instagram.cta || 'Follow for more!',
              overallScore: visualAnalysisSuccess ? 88 : 40,
              seoStatus: visualAnalysisSuccess ? 'ready' : 'needs_review'
            },
            youtube: {
              title: ytTitle,
              description: String(parsed.youtube.description || `${primarySummary}\n\n${ytHashtags.join(' ')}`).trim(),
              hashtags: ytHashtags,
              tags: ytTags,
              categoryId: dynamicCategoryId,
              seoStatus: visualAnalysisSuccess ? 'ready' : 'needs_review'
            }
          };
        }
      }
    } catch (aiErr) {
      logger.warn?.(`[Shared Metadata] AI metadata formatting failed, using safe visual fallback: ${aiErr.message}`);
    }
  }

  // 5. Fallback if AI formatting was unavailable or failed
  if (!generated) {
    generated = buildSafeDeterministicMetadata(primaryTopic, visualAnalysis, visualAnalysisSuccess);
  }

  // 6. If visual analysis failed across all providers, ensure status reflects needs_review
  if (!visualAnalysisSuccess) {
    if (generated.youtube) generated.youtube.seoStatus = 'needs_review';
    if (generated.instagram) generated.instagram.seoStatus = 'needs_review';
  }

  // 7. Cache unified metadata ONLY if visual analysis succeeded!
  // Do not poison the cache with failed runs so future attempts can retry cleanly.
  if (visualAnalysisSuccess) {
    cache[contentHash] = {
      ...generated,
      contentHash,
      fileName,
      visualAnalysis,
      visualAnalysisSuccess: true,
      updatedAt: new Date().toISOString()
    };
    cache[fileName] = cache[contentHash];
    saveCache(cache);
  }

  return {
    contentHash,
    visualAnalysis,
    visualAnalysisSuccess,
    visualAnalysisError,
    needsReview: !visualAnalysisSuccess,
    reviewReason: !visualAnalysisSuccess
      ? `Multimodal visual analysis failed across providers (${visualAnalysisError || 'Vision unavailable'}). Held for retry/review.`
      : null,
    ...generated,
    cached: false
  };
}

module.exports = {
  computeFileContentHash,
  cleanTopicFromFileName,
  processSharedVideoMetadata,
  buildSafeDeterministicMetadata,
  resolveYouTubeCategoryId,
  YOUTUBE_CATEGORY_MAP,
  loadCache,
  saveCache
};
