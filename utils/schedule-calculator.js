/**
 * Schedule Calculator
 * Calculates daily slots and handles overflow carry-over for:
 * - Instagram: 10 reels / day
 * - YouTube: 6 videos / day
 * Timezone-aware, collision-free, idempotent across restarts.
 */

const DEFAULT_TARGETS = {
  instagram: 10,
  youtube: 6
};

// Distribution templates (hours and minutes in 24h format throughout active creator windows)
const DAILY_SLOT_TEMPLATES = {
  // 10 reels distributed across 08:30 to 22:30 (approx every 85-90 min)
  instagram: [
    { hour: 8, minute: 30 },
    { hour: 10, minute: 0 },
    { hour: 11, minute: 30 },
    { hour: 13, minute: 0 },
    { hour: 14, minute: 30 },
    { hour: 16, minute: 0 },
    { hour: 17, minute: 30 },
    { hour: 19, minute: 0 },
    { hour: 20, minute: 30 },
    { hour: 22, minute: 0 }
  ],
  // 6 videos distributed across peak US audience windows (07:00, 10:00, 13:00, 16:00, 19:00, 21:00)
  youtube: [
    { hour: 7, minute: 0 },
    { hour: 10, minute: 0 },
    { hour: 13, minute: 0 },
    { hour: 16, minute: 0 },
    { hour: 19, minute: 0 },
    { hour: 21, minute: 0 }
  ]
};

/**
 * Returns configured daily target for a platform.
 */
async function getDailyTarget(db, platform) {
  const envKey = `${platform.toUpperCase()}_DAILY_TARGET`;
  if (process.env[envKey]) {
    const val = parseInt(process.env[envKey], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  if (db?.getSetting) {
    try {
      const settingVal = await db.getSetting(`${platform}_daily_target`);
      if (settingVal) {
        const val = parseInt(settingVal, 10);
        if (!isNaN(val) && val > 0) return val;
      }
    } catch (_) {}
  }
  return DEFAULT_TARGETS[platform] || 6;
}

/**
 * Get active timezone for calculations.
 * Defaults to America/Los_Angeles (US Pacific) for YouTube audience alignment.
 */
async function getTimezone(db, platform = 'youtube') {
  if (process.env.YOUTUBE_TIMEZONE && platform === 'youtube') return process.env.YOUTUBE_TIMEZONE;
  if (process.env.CHANNEL_TIMEZONE) return process.env.CHANNEL_TIMEZONE;
  if (db?.getSetting) {
    try {
      const ytTz = await db.getSetting('youtube_timezone');
      if (ytTz && platform === 'youtube') return ytTz;
      const tz = await db.getSetting('channel_timezone');
      if (tz && platform !== 'youtube') return tz;
    } catch (_) {}
  }
  return 'America/Los_Angeles';
}

/**
 * Formats a Date object into a YYYY-MM-DD string in the specified timezone.
 */
function getLocalDateString(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date); // en-CA gives YYYY-MM-DD
}

/**
 * Creates a UTC Date representing the target local date, hour, minute in the specified timezone.
 */
function createDateInTimezone(year, month, day, hour, minute, timezone) {
  // Use ISO representation and resolve offset using Intl
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  const paddedHour = String(hour).padStart(2, '0');
  const paddedMinute = String(minute).padStart(2, '0');

  // Find UTC timestamp matching this local time
  const naiveUtc = new Date(`${year}-${paddedMonth}-${paddedDay}T${paddedHour}:${paddedMinute}:00Z`);
  const invDate = new Date(naiveUtc.toLocaleString('en-US', { timeZone: timezone }));
  const diff = naiveUtc.getTime() - invDate.getTime();
  return new Date(naiveUtc.getTime() + diff);
}

/**
 * Retrieves the count and list of existing scheduled/published posts on a given local day.
 */
async function getExistingPostsForDay({ db, platform, dateString, timezone }) {
  const tableName = platform === 'youtube' ? 'publish_schedule' : 'instagram_publish_queue';
  // Check rows where status is scheduled or published
  const rows = db?.getAllRows
    ? await db.getAllRows(
        `SELECT id, publish_time, status, title
         FROM ${tableName}
         WHERE status IN ('scheduled', 'published', 'uploading', 'processing')
         ORDER BY publish_time ASC`
      ).catch(() => [])
    : [];

  return (rows || []).filter(row => {
    if (!row.publish_time) return false;
    const postDate = getLocalDateString(new Date(row.publish_time), timezone);
    return postDate === dateString;
  });
}

/**
 * Calculates the next available publishing slot for a platform.
 * Automatically distributes posts, limits to daily target, and rolls over to next days.
 */
async function getNextAvailableScheduleSlot({
  db,
  platform = 'youtube',
  targetPerDay = null,
  now = new Date(),
  timezone: explicitTz = null,
  targetDate = null,
  existingPosts: explicitExisting = null
}) {
  const timezone = explicitTz || (await getTimezone(db, platform));
  const target = targetPerDay || (await getDailyTarget(db, platform));
  const templates = DAILY_SLOT_TEMPLATES[platform] || DAILY_SLOT_TEMPLATES.youtube;

  // Minimum buffer ahead of now (5 minutes)
  const minFutureTime = new Date(now.getTime() + 5 * 60 * 1000);

  const maxOffsets = targetDate ? 1 : 30;

  for (let dayOffset = 0; dayOffset < maxOffsets; dayOffset++) {
    const checkDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const dateStr = targetDate || getLocalDateString(checkDate, timezone);
    const [year, month, day] = dateStr.split('-').map(Number);

    const existingPosts = explicitExisting !== null
      ? explicitExisting
      : (await getExistingPostsForDay({ db, platform, dateString: dateStr, timezone }));

    if (existingPosts.length >= target) {
      // Day is already full; continue to next day
      continue;
    }

    // Identify occupied slots by timestamp proximity (within 30 mins)
    const takenTimes = existingPosts.map(p => new Date(p.publishTime || p.publish_time).getTime());

    // Check templates for this day
    for (let slotIdx = 0; slotIdx < Math.min(target, templates.length); slotIdx++) {
      const template = templates[slotIdx];
      const candidateDate = createDateInTimezone(year, month, day, template.hour, template.minute, timezone);

      // Must be at least 5 minutes in the future unless targetDate is explicitly requested for dry run
      if (candidateDate.getTime() < minFutureTime.getTime() && !targetDate) {
        continue;
      }

      // Check collision with existing scheduled items (must be > 20 mins apart)
      const collides = takenTimes.some(t => Math.abs(t - candidateDate.getTime()) < 20 * 60 * 1000);
      if (!collides) {
        return candidateDate.toISOString();
      }
    }

    // If dayOffset === 0 (today) and all template slots passed, or existing occupied,
    // but day count < target, schedule in a safe upcoming window today if still before 23:00
    if ((dayOffset === 0 || targetDate) && existingPosts.length < target) {
      const lastTaken = takenTimes.length ? Math.max(...takenTimes) : minFutureTime.getTime();
      const nextCandidate = new Date(Math.max(minFutureTime.getTime(), lastTaken + 60 * 60 * 1000));
      const nextCandidateDateStr = getLocalDateString(nextCandidate, timezone);
      if (nextCandidateDateStr === dateStr) {
        return nextCandidate.toISOString();
      }
    }
  }

  // Fallback: 1 day in the future
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returns high-level daily quota metrics for the dashboard.
 */
async function getDailyQuotaMetrics(db) {
  const timezone = await getTimezone(db);
  const todayStr = getLocalDateString(new Date(), timezone);

  const [igTarget, ytTarget] = await Promise.all([
    getDailyTarget(db, 'instagram'),
    getDailyTarget(db, 'youtube')
  ]);

  const [igPostsToday, ytPostsToday] = await Promise.all([
    getExistingPostsForDay({ db, platform: 'instagram', dateString: todayStr, timezone }),
    getExistingPostsForDay({ db, platform: 'youtube', dateString: todayStr, timezone })
  ]);

  const igScheduled = igPostsToday.filter(p => p.status === 'scheduled').length;
  const igPublished = igPostsToday.filter(p => p.status === 'published').length;
  const igTotalToday = igPostsToday.length;

  const ytScheduled = ytPostsToday.filter(p => p.status === 'scheduled').length;
  const ytPublished = ytPostsToday.filter(p => p.status === 'published').length;
  const ytTotalToday = ytPostsToday.length;

  // Next scheduled posts
  const nextIg = await db.getRow(
    `SELECT id, title, publish_time, video_url
     FROM instagram_publish_queue
     WHERE status = 'scheduled' AND publish_time >= datetime('now')
     ORDER BY publish_time ASC LIMIT 1`
  ).catch(() => null);

  const nextYt = await db.getRow(
    `SELECT id, title, publish_time
     FROM publish_schedule
     WHERE status = 'scheduled' AND publish_time >= datetime('now')
     ORDER BY publish_time ASC LIMIT 1`
  ).catch(() => null);

  return {
    timezone,
    today: todayStr,
    instagram: {
      dailyTarget: igTarget,
      scheduledToday: igScheduled,
      publishedToday: igPublished,
      totalToday: igTotalToday,
      remainingToday: Math.max(0, igTarget - igTotalToday),
      nextScheduled: nextIg ? {
        id: nextIg.id,
        title: nextIg.title,
        publishTime: nextIg.publish_time
      } : null
    },
    youtube: {
      dailyTarget: ytTarget,
      scheduledToday: ytScheduled,
      publishedToday: ytPublished,
      totalToday: ytTotalToday,
      remainingToday: Math.max(0, ytTarget - ytTotalToday),
      nextScheduled: nextYt ? {
        id: nextYt.id,
        title: nextYt.title,
        publishTime: nextYt.publish_time
      } : null
    }
  };
}

module.exports = {
  getDailyTarget,
  getTimezone,
  getLocalDateString,
  getExistingPostsForDay,
  getNextAvailableScheduleSlot,
  getDailyQuotaMetrics
};
