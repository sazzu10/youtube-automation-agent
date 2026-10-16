const fs = require('fs');
const https = require('https');

const CONFIG_PATH = 'config/instagram.json';
const GRAPH_BASE = 'https://graph.instagram.com';

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

function request(path, method = 'GET', body = null) {
  const config = loadConfig();
  const url = new URL(path, GRAPH_BASE);

  url.searchParams.set('access_token', config.access_token);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: body
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          let parsed;

          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(
              new Error(`Instagram API returned invalid JSON: ${data}`)
            );
          }

          if (res.statusCode < 200 || res.statusCode >= 300 || parsed.error) {
            const message =
              parsed?.error?.message ||
              `Instagram API HTTP ${res.statusCode}`;

            return reject(new Error(message));
          }

          resolve(parsed);
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

async function getAccount() {
  return request('/me?fields=id,username');
}

module.exports = {
  loadConfig,
  request,
  getAccount,
};
