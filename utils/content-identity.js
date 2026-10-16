const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Computes a deterministic cryptographic content hash (SHA-256) of a file.
 * Fast, reliable, collision-resistant across Termux restarts and renames.
 */
function computeFileContentHash(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Invalid or empty file: ${filePath}`);
  }

  const hash = crypto.createHash('sha256');
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB

  if (stat.size <= 32 * 1024 * 1024) {
    const buf = fs.readFileSync(filePath);
    hash.update(buf);
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      hash.update(`SIZE:${stat.size}:`);
      const headBuf = Buffer.alloc(CHUNK_SIZE);
      const headRead = fs.readSync(fd, headBuf, 0, CHUNK_SIZE, 0);
      hash.update(headBuf.subarray(0, headRead));

      const midPos = Math.floor(stat.size / 2) - Math.floor(CHUNK_SIZE / 2);
      const midBuf = Buffer.alloc(CHUNK_SIZE);
      const midRead = fs.readSync(fd, midBuf, 0, CHUNK_SIZE, Math.max(0, midPos));
      hash.update(midBuf.subarray(0, midRead));

      const tailPos = Math.max(0, stat.size - CHUNK_SIZE);
      const tailBuf = Buffer.alloc(CHUNK_SIZE);
      const tailRead = fs.readSync(fd, tailBuf, 0, CHUNK_SIZE, tailPos);
      hash.update(tailBuf.subarray(0, tailRead));
    } finally {
      fs.closeSync(fd);
    }
  }

  return hash.digest('hex');
}

/**
 * Checks if this content has already been published to the given platform.
 */
async function checkDuplicatePublish({ db, contentHash, platform, productionId = null }) {
  if (!contentHash && !productionId) return { isDuplicate: false, record: null };

  // 1. Check published_media_registry
  if (contentHash && db.getRow) {
    try {
      const regRow = await db.getRow(
        `SELECT * FROM published_media_registry
         WHERE content_hash = ? AND platform = ? AND status = 'published'
         LIMIT 1`,
        [contentHash, platform]
      );
      if (regRow) {
        return {
          isDuplicate: true,
          platform,
          source: 'published_media_registry',
          record: regRow
        };
      }
    } catch (_) {}
  }

  // 2. Check platform-specific publishing tables
  if (platform === 'youtube') {
    try {
      const ytRow = await db.getRow(
        `SELECT * FROM publish_schedule
         WHERE ((content_hash = ? AND ? IS NOT NULL) OR (production_id = ? AND ? IS NOT NULL))
           AND status = 'published' AND youtube_id IS NOT NULL
         ORDER BY published_at DESC LIMIT 1`,
        [contentHash || null, contentHash || null, productionId || null, productionId || null]
      );
      if (ytRow) {
        // Backfill into registry if hash available
        if (contentHash && db.savePublishedMediaRegistry) {
          await db.savePublishedMediaRegistry({
            contentHash,
            platform: 'youtube',
            productionId: ytRow.production_id,
            platformPostId: ytRow.youtube_id,
            platformUrl: ytRow.youtube_url || `https://www.youtube.com/watch?v=${ytRow.youtube_id}`,
            publishedAt: ytRow.published_at
          }).catch(() => {});
        }
        return {
          isDuplicate: true,
          platform: 'youtube',
          source: 'publish_schedule',
          record: ytRow
        };
      }
    } catch (_) {}
  }

  if (platform === 'instagram') {
    try {
      const igRow = await db.getRow(
        `SELECT * FROM instagram_publish_queue
         WHERE ((content_hash = ? AND ? IS NOT NULL) OR (production_id = ? AND ? IS NOT NULL))
           AND status = 'published' AND instagram_media_id IS NOT NULL
         ORDER BY published_at DESC LIMIT 1`,
        [contentHash || null, contentHash || null, productionId || null, productionId || null]
      );
      if (igRow) {
        if (contentHash && db.savePublishedMediaRegistry) {
          await db.savePublishedMediaRegistry({
            contentHash,
            platform: 'instagram',
            productionId: igRow.production_id,
            platformPostId: igRow.instagram_media_id,
            platformUrl: null,
            publishedAt: igRow.published_at
          }).catch(() => {});
        }
        return {
          isDuplicate: true,
          platform: 'instagram',
          source: 'instagram_publish_queue',
          record: igRow
        };
      }
    } catch (_) {}
  }

  return { isDuplicate: false, record: null };
}

/**
 * Checks if the content is currently scheduled or in-progress.
 */
async function checkPendingQueue({ db, contentHash, platform, productionId = null }) {
  if (!contentHash && !productionId) return { isQueued: false, record: null };

  if (platform === 'youtube') {
    try {
      const row = await db.getRow(
        `SELECT * FROM publish_schedule
         WHERE ((content_hash = ? AND ? IS NOT NULL) OR (production_id = ? AND ? IS NOT NULL))
           AND status IN ('scheduled', 'uploading', 'publishing', 'paused')
         ORDER BY publish_time ASC LIMIT 1`,
        [contentHash || null, contentHash || null, productionId || null, productionId || null]
      );
      if (row) return { isQueued: true, platform: 'youtube', record: row };
    } catch (_) {}
  }

  if (platform === 'instagram') {
    try {
      const row = await db.getRow(
        `SELECT * FROM instagram_publish_queue
         WHERE ((content_hash = ? AND ? IS NOT NULL) OR (production_id = ? AND ? IS NOT NULL))
           AND status IN ('scheduled', 'processing', 'publishing')
         ORDER BY publish_time ASC LIMIT 1`,
        [contentHash || null, contentHash || null, productionId || null, productionId || null]
      );
      if (row) return { isQueued: true, platform: 'instagram', record: row };
    } catch (_) {}
  }

  return { isQueued: false, record: null };
}

/**
 * Atomic claim to prevent race conditions between workers/schedulers.
 */
async function atomicClaimJob({ db, platform, id, workerId = 'worker' }) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  if (platform === 'youtube') {
    const res = await db.executeQuery(
      `UPDATE publish_schedule
       SET status = 'uploading',
           locked_at = datetime('now'),
           locked_by = ?
       WHERE id = ?
         AND (status = 'scheduled' OR (status = 'uploading' AND (locked_at IS NULL OR locked_at < ?)))`,
      [workerId, id, cutoff]
    );
    return res?.changes > 0;
  }

  if (platform === 'instagram') {
    const res = await db.executeQuery(
      `UPDATE instagram_publish_queue
       SET status = 'processing',
           locked_at = datetime('now'),
           locked_by = ?
       WHERE id = ?
         AND (status = 'scheduled' OR (status = 'processing' AND (locked_at IS NULL OR locked_at < ?)))`,
      [workerId, id, cutoff]
    );
    return res?.changes > 0;
  }

  return false;
}

/**
 * Releases lock on failed or postponed job.
 */
async function releaseJobLock({ db, platform, id, status = 'scheduled', errorMessage = null }) {
  if (platform === 'youtube') {
    await db.executeQuery(
      `UPDATE publish_schedule
       SET status = ?,
           locked_at = NULL,
           locked_by = NULL,
           error_message = COALESCE(?, error_message)
       WHERE id = ?`,
      [status, errorMessage, id]
    );
  }
  if (platform === 'instagram') {
    await db.executeQuery(
      `UPDATE instagram_publish_queue
       SET status = ?,
           locked_at = NULL,
           locked_by = NULL,
           error_message = COALESCE(?, error_message)
       WHERE id = ?`,
      [status, errorMessage, id]
    );
  }
}

/**
 * Records successful publication in the persistent registry.
 */
async function recordPublishSuccess({ db, contentHash, platform, productionId, platformPostId, platformUrl = null }) {
  const id = `reg_${platform}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.executeQuery(
    `INSERT INTO published_media_registry
       (id, content_hash, platform, production_id, platform_post_id, platform_url, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, 'published', datetime('now'))
     ON CONFLICT(content_hash, platform) DO UPDATE SET
       production_id = excluded.production_id,
       platform_post_id = excluded.platform_post_id,
       platform_url = COALESCE(excluded.platform_url, published_media_registry.platform_url),
       status = 'published',
       published_at = datetime('now')`,
    [id, contentHash, platform, productionId, platformPostId, platformUrl]
  );
}

module.exports = {
  computeFileContentHash,
  checkDuplicatePublish,
  checkPendingQueue,
  atomicClaimJob,
  releaseJobLock,
  recordPublishSuccess
};
