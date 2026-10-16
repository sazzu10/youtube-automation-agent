const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve('config/instagram.json');
const GRAPH_BASE = 'https://graph.instagram.com';


const __postfileByContainer = new Map();

async function __postfileUpload(videoUrl) {
  const key = process.env.POSTFILE_API_KEY;
  if (!key) return {url: videoUrl, fileId: null};

  if (videoUrl.includes("cdn.postfile.download")) {
    return {url: videoUrl, fileId: null};
  }

  // Auto-recover Cloudinary URLs that were inadvertently rewritten with an ephemeral trycloudflare.com hostname
  if (videoUrl.includes("trycloudflare.com") && videoUrl.includes("/video/upload/")) {
    const recoveredCloudinary = videoUrl.replace(/https:\/\/[^/]+\.trycloudflare\.com/, "https://res.cloudinary.com");
    return {url: recoveredCloudinary, fileId: null};
  }

  let filename = null;
  try {
    filename = decodeURIComponent(new URL(videoUrl).pathname.split("/").pop());
  } catch {}

  if (!filename || filename.includes("..") || !/\.(mp4|mov|m4v|webm)$/i.test(filename)) {
    return {url: videoUrl, fileId: null};
  }

  const candidates = [
    path.resolve("content/processing", filename),
    path.resolve("content", filename),
    path.resolve("tmp", filename),
  ];

  let local = candidates.find(x => fs.existsSync(x));

  let bytes;
  let contentType = "video/mp4";

  if (local) {
    bytes = fs.readFileSync(local);
  } else {
    try {
      const source = await fetch(videoUrl);
      if (!source.ok) {
        throw new Error(`Source video download failed: HTTP ${source.status}`);
      }
      bytes = Buffer.from(await source.arrayBuffer());
      contentType = source.headers.get("content-type") || contentType;
    } catch (fetchErr) {
      if (videoUrl.includes("trycloudflare.com") || videoUrl.includes("localhost") || videoUrl.includes("127.0.0.1")) {
        throw new Error(`Video URL is unreachable (expired tunnel or local address: ${videoUrl}). Local source file not found on disk.`);
      }
      throw fetchErr;
    }
  }

  if (bytes.length > 50 * 1024 * 1024) {
    throw new Error(`PostFile limit exceeded: ${bytes.length} bytes`);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], {type: contentType}),
    filename
  );

  const response = await fetch("https://upload.postfile.net/v1/upload", {
    method: "POST",
    headers: {"X-API-Key": key},
    body: form
  });

  const data = await response.json();

  if (!response.ok || !data.url || !data.file_id) {
    throw new Error(`PostFile upload failed: ${JSON.stringify(data)}`);
  }

  return {url: data.url, fileId: data.file_id};
}

async function __postfileDelete(fileId) {
  const key = process.env.POSTFILE_API_KEY;
  if (!key || !fileId) return;

  try {
    const response = await fetch(
      `https://postfile.net/v1/files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: {"X-API-Key": key}
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function __postfileCleanupContainer(containerId) {
  const fileId = __postfileByContainer.get(containerId);
  if (!fileId) return;
  await __postfileDelete(fileId);
  __postfileByContainer.delete(containerId);
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!config.access_token) {
    throw new Error('Instagram access token is missing');
  }

  if (!config.ig_user_id) {
    throw new Error('Instagram user ID is missing');
  }

  return config;
}

async function instagramRequest(endpoint, options = {}) {
  const config = loadConfig();

  const url = new URL(endpoint, GRAPH_BASE);
  url.searchParams.set('access_token', config.access_token);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Instagram API request timed out after 30s: ${url.pathname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data?.error?.message ||
      `Instagram API HTTP ${response.status}`
    );
  }

  return data;
}

async function createMediaContainer({
  videoUrl,
  caption = '',
  mediaType = 'REELS',
}) {
  if (!videoUrl) {
    throw new Error('videoUrl is required');
  }

  const config = loadConfig();

  const hosted = await __postfileUpload(videoUrl);
  videoUrl = hosted.url;

  const body = new URLSearchParams({
    media_type: mediaType,
    video_url: videoUrl,
    caption,
  });

  const url = new URL(`/${config.ig_user_id}/media`, GRAPH_BASE);
  url.searchParams.set('access_token', config.access_token);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    if (hosted?.fileId) await __postfileDelete(hosted.fileId);
    throw new Error(
      data?.error?.message ||
      `Instagram media container HTTP ${response.status}`
    );
  }

  if (hosted?.fileId && data.id) {
    __postfileByContainer.set(data.id, hosted.fileId);
  }

  return data;
}

async function getContainerStatus(containerId) {
  if (!containerId) {
    throw new Error('containerId is required');
  }

  const data = await instagramRequest(
    `/${containerId}?fields=status_code,status,error_message`
  );

  if (data.status_code === 'ERROR' || data.status === 'ERROR') {
    await __postfileCleanupContainer(containerId);
  }

  return data;
}

async function publishContainer(containerId) {
  if (!containerId) {
    throw new Error('containerId is required');
  }

  const config = loadConfig();

  const url = new URL(`/${config.ig_user_id}/media_publish`, GRAPH_BASE);
  url.searchParams.set('access_token', config.access_token);

  const body = new URLSearchParams({
    creation_id: containerId,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data?.error?.message ||
      `Instagram publish HTTP ${response.status}`
    );
  }

  await __postfileCleanupContainer(containerId);

  return data;
}

async function getPublishedMedia(limit = 25) {
  const config = loadConfig();
  const fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,username,like_count,comments_count';
  const data = await instagramRequest(
    `/${config.ig_user_id}/media?fields=${fields}&limit=${Math.min(limit, 50)}`
  );
  return data?.data || [];
}

async function getMediaInsights(mediaId) {
  if (!mediaId) throw new Error('mediaId is required');
  try {
    const data = await instagramRequest(
      `/${mediaId}/insights?metric=plays,reach,saved,shares,total_interactions`
    );
    const metrics = {};
    for (const item of (data?.data || [])) {
      if (item.name && Array.isArray(item.values) && item.values.length) {
        metrics[item.name] = item.values[0].value;
      } else if (item.name && item.total_value) {
        metrics[item.name] = item.total_value.value;
      }
    }
    return metrics;
  } catch (e) {
    // Insights might not be enabled for some account types or token scopes; return null gracefully
    return null;
  }
}

async function attemptTokenRefresh(currentToken) {
  try {
    const refreshUrl = new URL('/refresh_access_token', GRAPH_BASE);
    refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
    refreshUrl.searchParams.set('access_token', currentToken);

    const res = await fetch(refreshUrl);
    const data = await res.json();

    if (res.ok && data.access_token) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config.access_token = data.access_token;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      return { success: true };
    }
    return { success: false, error: data?.error?.message || 'Refresh failed' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function checkAuthStatus() {
  try {
    const config = loadConfig();
    const url = new URL('/me', GRAPH_BASE);
    url.searchParams.set('fields', 'id,username');
    url.searchParams.set('access_token', config.access_token);

    const res = await fetch(url);
    const data = await res.json();

    if (res.ok && data.id) {
      return {
        authenticated: true,
        userId: data.id,
        username: data.username || null,
        error: null
      };
    }

    // Try automatic token refresh
    const refreshResult = await attemptTokenRefresh(config.access_token);
    if (refreshResult.success) {
      return {
        authenticated: true,
        refreshed: true,
        userId: config.ig_user_id,
        error: null
      };
    }

    return {
      authenticated: false,
      userId: config.ig_user_id,
      error: data?.error?.message || refreshResult.error || 'Token validation failed',
      requiresReauth: true
    };
  } catch (err) {
    return {
      authenticated: false,
      error: err.message,
      requiresReauth: true
    };
  }
}

async function saveNewToken(newToken) {
  if (!newToken || typeof newToken !== 'string') {
    throw new Error('Valid token string required');
  }
  const token = newToken.trim();

  // Validate and get user profile
  const url = new URL('/me', GRAPH_BASE);
  url.searchParams.set('fields', 'id,username');
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || !data.id) {
    throw new Error(data?.error?.message || 'Invalid Instagram access token');
  }

  const config = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};

  config.access_token = token;
  config.ig_user_id = String(data.id);

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  return {
    success: true,
    userId: data.id,
    username: data.username || null
  };
}

function getOAuthAuthorizationUrl(redirectUri = 'http://localhost:3456/vidiq/api/instagram/oauth/callback') {
  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const appId = process.env.INSTAGRAM_APP_ID || config.app_id;
  if (!appId) {
    throw new Error('Meta App ID is missing. Please configure app_id in config/instagram.json or INSTAGRAM_APP_ID in .env.');
  }

  const authUrl = new URL('https://api.instagram.com/oauth/authorize');
  authUrl.searchParams.set('enable_fb_login', '0');
  authUrl.searchParams.set('force_authentication', '1');
  authUrl.searchParams.set('client_id', appId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'instagram_business_basic,instagram_business_content_publish');

  return authUrl.toString();
}

async function exchangeAuthCodeForLongLivedToken(code, redirectUri = 'http://localhost:3456/vidiq/api/instagram/oauth/callback') {
  if (!code) throw new Error('Authorization code is required');
  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const appId = process.env.INSTAGRAM_APP_ID || config.app_id;
  const appSecret = process.env.INSTAGRAM_APP_SECRET || config.app_secret;

  if (!appId || !appSecret) {
    throw new Error('Meta App ID and App Secret are required for OAuth code exchange.');
  }

  // 1. Exchange auth code for short-lived access token
  const form = new URLSearchParams();
  form.set('client_id', appId);
  form.set('client_secret', appSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code.trim());

  const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: form
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData?.error_message || tokenData?.error?.message || 'Failed to exchange authorization code for access token');
  }

  const shortLivedToken = tokenData.access_token;

  // 2. Exchange short-lived token for long-lived 60-day token
  const exchangeUrl = new URL('/access_token', GRAPH_BASE);
  exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
  exchangeUrl.searchParams.set('client_secret', appSecret);
  exchangeUrl.searchParams.set('access_token', shortLivedToken);

  const longLivedRes = await fetch(exchangeUrl);
  const longLivedData = await longLivedRes.json();

  const finalToken = (longLivedRes.ok && longLivedData.access_token)
    ? longLivedData.access_token
    : shortLivedToken;

  // 3. Save new token and auto-resolve user ID
  return await saveNewToken(finalToken);
}

function updateAppCredentials({ appId, appSecret }) {
  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  if (appId) config.app_id = String(appId).trim();
  if (appSecret) config.app_secret = String(appSecret).trim();
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return { success: true, hasAppId: Boolean(config.app_id), hasAppSecret: Boolean(config.app_secret) };
}

async function verifyTokenRefreshCapability() {
  const config = loadConfig();
  const refreshUrl = new URL('/refresh_access_token', GRAPH_BASE);
  refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
  refreshUrl.searchParams.set('access_token', config.access_token);

  try {
    const res = await fetch(refreshUrl);
    const data = await res.json();

    if (res.ok && data.access_token) {
      config.access_token = data.access_token;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      return { success: true, refreshed: true, message: 'Access token renewed successfully' };
    }

    const msg = data?.error?.message || '';
    if (msg.includes('less than 24 hours old') || msg.includes('24 hours')) {
      return { success: true, refreshed: false, message: 'Token is active (<24h old); refresh endpoint connection verified' };
    }

    return { success: false, error: msg || `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  loadConfig,
  instagramRequest,
  createMediaContainer,
  getContainerStatus,
  publishContainer,
  getPublishedMedia,
  getMediaInsights,
  checkAuthStatus,
  attemptTokenRefresh,
  verifyTokenRefreshCapability,
  saveNewToken,
  getOAuthAuthorizationUrl,
  exchangeAuthCodeForLongLivedToken,
  updateAppCredentials,
};
