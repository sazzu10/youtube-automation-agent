const sqlite3 = require('sqlite3').verbose();

const DB_PATH = 'data/youtube_automation.db';

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);

    db.run(sql, params, function (err) {
      db.close();

      if (err) return reject(err);

      resolve({
        changes: this.changes,
        lastID: this.lastID,
      });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);

    db.get(sql, params, (err, row) => {
      db.close();

      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);

    db.all(sql, params, (err, rows) => {
      db.close();

      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function ensureRepublishColumns() {
  try {
    const db = new sqlite3.Database(DB_PATH);
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN original_media_id TEXT', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN original_published_record_id TEXT', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN optimization_version INTEGER DEFAULT 1', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN content_hash TEXT', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN idempotency_key TEXT', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN locked_at TEXT', () => {});
    db.run('ALTER TABLE instagram_publish_queue ADD COLUMN locked_by TEXT', () => {});
    db.close();
  } catch (_) {}
}
ensureRepublishColumns();

async function addToQueue({
  id,
  productionId,
  title,
  publishTime,
  priority = 50,
  videoUrl = null,
  caption = '',
  originalMediaId = null,
  originalPublishedRecordId = null,
  optimizationVersion = 1,
  contentHash = null,
  idempotencyKey = null,
}) {
  if (!id || !productionId || !title || !publishTime) {
    throw new Error('id, productionId, title and publishTime are required');
  }

  // Idempotency check: Do not insert duplicate job if already scheduled, processing, or published
  const existing = await get(
    `SELECT * FROM instagram_publish_queue
     WHERE (id = ? OR production_id = ? OR (content_hash = ? AND ? IS NOT NULL))
       AND status IN ('scheduled', 'processing', 'published')
     LIMIT 1`,
    [id, productionId, contentHash || null, contentHash || null]
  );

  if (existing) {
    return {
      changes: 0,
      id: existing.id,
      reused: true,
      status: existing.status
    };
  }

  return run(
    `INSERT INTO instagram_publish_queue
      (id, production_id, title, publish_time, status, priority, video_url, caption, original_media_id, original_published_record_id, optimization_version, content_hash, idempotency_key)
     VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      productionId,
      title,
      publishTime,
      priority,
      videoUrl,
      caption,
      originalMediaId,
      originalPublishedRecordId,
      optimizationVersion,
      contentHash,
      idempotencyKey || `ig_${productionId}`
    ]
  );
}

async function getById(id) {
  return get(
    'SELECT * FROM instagram_publish_queue WHERE id = ?',
    [id]
  );
}

async function getDuePosts(now = new Date().toISOString()) {
  return all(
    `SELECT *
     FROM instagram_publish_queue
     WHERE status = 'scheduled'
       AND publish_time <= ?
     ORDER BY priority ASC, publish_time ASC`,
    [now]
  );
}

async function claimPost(id, workerId = 'ig_worker') {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return run(
    `UPDATE instagram_publish_queue
     SET status = 'processing',
         locked_at = CURRENT_TIMESTAMP,
         locked_by = ?
     WHERE id = ?
       AND (status = 'scheduled' OR (status = 'processing' AND (locked_at IS NULL OR locked_at < ?)))`,
    [workerId, id, cutoff]
  );
}

async function releaseClaim(id, status = 'scheduled', errorMessage = null) {
  return run(
    `UPDATE instagram_publish_queue
     SET status = ?,
         locked_at = NULL,
         locked_by = NULL,
         error_message = COALESCE(?, error_message),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, errorMessage, id]
  );
}

async function recoverStaleProcessing(minutes = 15) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  return run(
    `UPDATE instagram_publish_queue
     SET status = 'scheduled',
         retry_count = COALESCE(retry_count, 0) + 1,
         error_message = 'Recovered stale processing job after worker restart',
         locked_at = NULL,
         locked_by = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE status = 'processing'
       AND (locked_at < ? OR (locked_at IS NULL AND updated_at < ?))`,
    [cutoff, cutoff]
  );
}

async function update(id, fields) {
  const allowed = [
    'status',
    'video_url',
    'caption',
    'container_id',
    'instagram_media_id',
    'published_at',
    'error_message',
    'retry_count',
    'original_media_id',
    'original_published_record_id',
    'optimization_version',
    'content_hash',
    'idempotency_key',
    'locked_at',
    'locked_by'
  ];

  const entries = Object.entries(fields)
    .filter(([key]) => allowed.includes(key));

  if (!entries.length) {
    throw new Error('No valid fields to update');
  }

  const setClause = entries
    .map(([key]) => `${key} = ?`)
    .join(', ');

  const values = entries.map(([, value]) => value);

  values.push(id);

  return run(
    `UPDATE instagram_publish_queue
     SET ${setClause}, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    values
  );
}

module.exports = {
  addToQueue,
  getById,
  getDuePosts,
  claimPost,
  releaseClaim,
  recoverStaleProcessing,
  update,
};
