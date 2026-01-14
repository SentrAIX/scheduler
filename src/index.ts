import dotenv from 'dotenv';
dotenv.config();

import axios, { AxiosInstance } from 'axios';
import * as qs from 'querystring';

// p-retry v5 is ESM-only. Load it dynamically so CommonJS entrypoint
// can still initialize the module at runtime without using `import()` failing.
let pRetry: any;
async function initPRetry(): Promise<void> {
  const mod = await import('p-retry');
  pRetry = (mod && (mod as any).default) ? (mod as any).default : mod;
}

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || '120', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10);

const KEYCLOAK_ISSUER_URL = process.env.KEYCLOAK_ISSUER_URL || process.env.KEYCLOAK_URL || '';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || '';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || '';
const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || '';

if (!API_KEY && !(KEYCLOAK_ISSUER_URL && KEYCLOAK_REALM && KEYCLOAK_CLIENT_ID && KEYCLOAK_CLIENT_SECRET)) {
  // eslint-disable-next-line no-console
  console.warn('Warning: No API_KEY or Keycloak client-credentials configured. Scheduler calls will be unauthenticated.');
}

const axiosClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL.replace(/\/$/, '') + '/api',
  timeout: HTTP_TIMEOUT_MS,
});

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

async function fetchAccessToken(): Promise<string | null> {
  if (!KEYCLOAK_ISSUER_URL || !KEYCLOAK_REALM || !KEYCLOAK_CLIENT_ID || !KEYCLOAK_CLIENT_SECRET) return null;

  const tokenUrl = `${KEYCLOAK_ISSUER_URL.replace(/\/$/, '')}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
  const body = qs.stringify({ grant_type: 'client_credentials', client_id: KEYCLOAK_CLIENT_ID, client_secret: KEYCLOAK_CLIENT_SECRET });

  const resp = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
  if (resp && (resp as any).data && (resp as any).data.access_token) {
    accessToken = (resp as any).data.access_token;
    const expiresIn = (resp as any).data.expires_in || 300;
    accessTokenExpiresAt = Date.now() + expiresIn * 1000 - 30000;
    return accessToken;
  }
  return null;
}

async function getAccessToken(): Promise<string | null> {
  if (API_KEY) return API_KEY;
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  try {
    const t = await fetchAccessToken();
    return t;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn('[scheduler] Failed to fetch access token from Keycloak:', err && err.message ? err.message : err);
    return null;
  }
}

axiosClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers = config.headers || {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }
  return config;
}, (err) => Promise.reject(err));

/**
 * Request the API to process pending billing events. The scheduler is only
 * responsible for triggering processing; the API implements the actual work.
 */
async function processPending(limit: number) {
  return pRetry(async () => {
    const resp = await axiosClient.post('/billing/process-pending', { limit });
    if (!(resp && resp.status >= 200 && resp.status < 300)) {
      const err: any = new Error(`Unexpected status ${(resp as any).status}`);
      err.response = resp;
      throw err;
    }
    return (resp as any).data;
  }, { retries: 3 });
}

async function runOnce() {
  try {
    // eslint-disable-next-line no-console
    console.info(`[scheduler] Polling for pending billing events (limit=${BATCH_SIZE})`);
    const resp = await processPending(BATCH_SIZE);
    // eslint-disable-next-line no-console
    console.info('[scheduler] processPending response:', resp);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[scheduler] Error during run:', err && err.message ? err.message : err);
  }
}

async function start() {
  // eslint-disable-next-line no-console
  console.info(`[scheduler] Starting scheduler (poll every ${POLL_INTERVAL_SECONDS}s)`);
  await initPRetry();
  await runOnce();
  setInterval(runOnce, POLL_INTERVAL_SECONDS * 1000);
}

start().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[scheduler] Unhandled error starting scheduler:', err && err.message ? err.message : err);
  process.exit(1);
});
