require('dotenv').config();
const axios = require('axios');
// p-retry v5 is ESM-only. Load it dynamically so CommonJS entrypoint
// can still initialize the module at runtime without using `require()`.
let pRetry;
async function initPRetry() {
  const _pRetry = await import('p-retry');
  pRetry = (_pRetry && _pRetry.default) ? _pRetry.default : _pRetry;
}
const qs = require('querystring');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || '120', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10);

// Keycloak client-credentials config (optional, preferred)
const KEYCLOAK_ISSUER_URL = process.env.KEYCLOAK_ISSUER_URL || process.env.KEYCLOAK_URL || '';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || '';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || '';
const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || '';

if (!API_KEY && !(KEYCLOAK_ISSUER_URL && KEYCLOAK_REALM && KEYCLOAK_CLIENT_ID && KEYCLOAK_CLIENT_SECRET)) {
  console.warn('Warning: No API_KEY or Keycloak client-credentials configured. Scheduler calls will be unauthenticated.');
}

const axiosClient = axios.create({
  // Ensure scheduler targets the API mount path. API_BASE_URL in .env is expected
  // to be like `http://localhost:3000` so append `/api` here to reach
  // e.g. `http://localhost:3000/api/billing/pending`.
  baseURL: API_BASE_URL.replace(/\/$/, '') + '/api',
  timeout: HTTP_TIMEOUT_MS,
});

// Access token cache
let accessToken = null;
let accessTokenExpiresAt = 0;

async function fetchAccessToken() {
  if (!KEYCLOAK_ISSUER_URL || !KEYCLOAK_REALM || !KEYCLOAK_CLIENT_ID || !KEYCLOAK_CLIENT_SECRET) {
    return null;
  }

  const tokenUrl = `${KEYCLOAK_ISSUER_URL.replace(/\/$/, '')}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
  const body = qs.stringify({ grant_type: 'client_credentials', client_id: KEYCLOAK_CLIENT_ID, client_secret: KEYCLOAK_CLIENT_SECRET });

  const resp = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
  if (resp && resp.data && resp.data.access_token) {
    accessToken = resp.data.access_token;
    const expiresIn = resp.data.expires_in || 300;
    // refresh 30s before expiry
    accessTokenExpiresAt = Date.now() + (expiresIn * 1000) - 30000;
    // Token fetched and cached; debug logging removed to avoid exposing token details.
    return accessToken;
  }
  return null;
}

async function getAccessToken() {
  if (API_KEY) return API_KEY;
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  try {
    const t = await fetchAccessToken();
    return t;
  } catch (err) {
    console.warn('[scheduler] Failed to fetch access token from Keycloak:', err && err.message ? err.message : err);
    return null;
  }
}

// Axios request interceptor to inject Authorization header
axiosClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (err) => Promise.reject(err));

async function fetchPending(limit) {
  const response = await axiosClient.get('/billing/pending', { params: { limit } });
  return response.data && response.data.data ? response.data.data : [];
}

async function sendUsageEvent(testExecutionId) {
  // p-retry handles retry/backoff for transient errors
  return pRetry(async () => {
    const resp = await axiosClient.post('/billing/usage-event', { testExecutionId });
    if (!(resp && resp.status >= 200 && resp.status < 300)) {
      const err = new Error(`Unexpected status ${resp.status}`);
      // @ts-ignore
      err.response = resp;
      throw err;
    }
    return resp.data;
  }, { retries: 3 });
}

async function runOnce() {
  try {
    console.info(`[scheduler] Polling for pending billing events (limit=${BATCH_SIZE})`);
    const pending = await fetchPending(BATCH_SIZE);
    if (!pending || pending.length === 0) {
      console.info('[scheduler] No pending billing events found');
      return;
    }

    console.info(`[scheduler] Found ${pending.length} pending execution(s)`);

    for (const item of pending) {
      const id = item.id;
      try {
        await sendUsageEvent(id);
        console.info(`[scheduler] Billing event sent for execution ${id}`);
      } catch (err) {
        console.error(`[scheduler] Failed to send billing event for ${id}: ${err && err.message ? err.message : err}`);
      }
    }
  } catch (err) {
    console.error('[scheduler] Error during run:', err instanceof Error ? err.message : err);
  }
}

async function start() {
  console.info(`[scheduler] Starting scheduler (poll every ${POLL_INTERVAL_SECONDS}s)`);
  // Ensure ESM-only dependencies are loaded before first run.
  await initPRetry();
  // Run immediately, then interval
  await runOnce();
  setInterval(runOnce, POLL_INTERVAL_SECONDS * 1000);
}

start().catch(err => {
  console.error('[scheduler] Unhandled error starting scheduler:', err instanceof Error ? err.message : err);
  process.exit(1);
});
