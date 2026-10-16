const queue = require('./queue');
const {
  createMediaContainer,
  getContainerStatus,
  publishContainer,
} = require('./publisher');
const {
  checkDuplicatePublish,
  recordPublishSuccess
} = require('../../utils/content-identity');

class InstagramWorker {
  constructor({ logger = console, db = null } = {}) {
    this.logger = logger;
    this.db = db;
    this.isRunning = false;
  }

  async processDuePosts() {
    if (this.isRunning) {
      this.logger.warn?.('Instagram worker already running; skipping overlapping run');
      return 0;
    }

    this.isRunning = true;
    let published = 0;

    try {
      await queue.recoverStaleProcessing?.(15);
      const posts = (await queue.getDuePosts()).slice(0, 5);

      for (const post of posts) {
        // 1. Atomic claim lock
        const claimed = await queue.claimPost(post.id, `ig_worker_${process.pid}`);
        if (!claimed || claimed.changes === 0) {
          this.logger.info?.(`Instagram post ${post.id} already claimed or in-progress; skipping`);
          continue;
        }

        try {
          if (!post.video_url) {
            throw new Error('Instagram queue item has no video_url');
          }

          // 2. Pre-publish duplicate check
          if (post.instagram_media_id) {
            this.logger.info?.(`Instagram post ${post.id} already has media ID ${post.instagram_media_id}; marking published`);
            await queue.update(post.id, {
              status: 'published',
              published_at: post.published_at || new Date().toISOString(),
              error_message: null
            });
            published++;
            continue;
          }

          if (post.content_hash) {
            const dup = await checkDuplicatePublish({
              db: this.db || {
                getRow: (sql, params) => queue.get ? queue.get(sql, params) : null
              },
              contentHash: post.content_hash,
              platform: 'instagram',
              productionId: post.production_id
            });

            if (dup.isDuplicate && dup.record?.platform_post_id) {
              this.logger.warn?.(`DUPLICATE PREVENTED: Content ${post.content_hash.slice(0, 12)} already published on Instagram (${dup.record.platform_post_id})`);
              await queue.update(post.id, {
                status: 'published',
                instagram_media_id: dup.record.platform_post_id,
                published_at: dup.record.published_at || new Date().toISOString(),
                error_message: null
              });
              published++;
              continue;
            }
          }

          // Reuse an existing container whenever possible.
          let containerId = post.container_id;

          if (!containerId) {
            const container = await createMediaContainer({
              videoUrl: post.video_url,
              caption: post.caption || '',
            });

            containerId = container.id;

            await queue.update(post.id, {
              container_id: containerId,
            });

            this.logger.info?.(
              `Instagram container created: ${post.id} -> ${containerId}`
            );
          } else {
            this.logger.info?.(
              `Instagram container reused: ${post.id} -> ${containerId}`
            );
          }

          let status = null;

          // Instagram video processing can take several minutes.
          for (let attempt = 0; attempt < 180; attempt++) {
            status = await getContainerStatus(containerId);

            if (status.status_code === 'FINISHED') {
              break;
            }

            if (
              status.status_code === 'ERROR' ||
              status.status === 'ERROR'
            ) {
              const errorReason = status.error_message || JSON.stringify(status);
              await queue.update(post.id, {
                container_id: null,
                error_message: `Instagram container ERROR: ${errorReason}`
              });

              throw new Error(
                `Instagram container processing failed: ${errorReason}`
              );
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
          }

          if (!status || status.status_code !== 'FINISHED') {
            throw new Error('Instagram container processing timed out');
          }

          const publishedResult = await publishContainer(containerId);
          const publishedAt = new Date().toISOString();

          await queue.update(post.id, {
            status: 'published',
            instagram_media_id: publishedResult.id,
            published_at: publishedAt,
            error_message: null,
          });

          // Record in persistent registry
          if (post.content_hash) {
            try {
              const sqlite3 = require('sqlite3').verbose();
              const dbConn = new sqlite3.Database('data/youtube_automation.db');
              const regId = `reg_ig_${Date.now()}`;
              dbConn.run(
                `INSERT INTO published_media_registry (id, content_hash, platform, production_id, platform_post_id, status, published_at)
                 VALUES (?, ?, 'instagram', ?, ?, 'published', ?)
                 ON CONFLICT(content_hash, platform) DO UPDATE SET
                   platform_post_id = excluded.platform_post_id,
                   status = 'published',
                   published_at = excluded.published_at`,
                [regId, post.content_hash, post.production_id, publishedResult.id, publishedAt],
                () => { dbConn.close(); }
              );
            } catch (_) {}
          }

          published++;

          this.logger.info?.(
            `Instagram post published: ${post.id} -> ${publishedResult.id}`
          );

        } catch (error) {
          const retries = Number(post.retry_count || 0) + 1;

          await queue.releaseClaim(
            post.id,
            retries >= 5 ? 'failed' : 'scheduled',
            error.message
          );

          await queue.update(post.id, {
            retry_count: retries,
          });

          this.logger.error?.(
            `Instagram post failed: ${post.id}: ${error.message}`
          );
        }
      }

      return published;
    } finally {
      this.isRunning = false;
    }
  }
}
module.exports = { InstagramWorker };
