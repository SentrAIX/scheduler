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
const POLL_INTERVAL_BILLING_SECONDS = parseInt(process.env.POLL_INTERVAL_BILLING_SECONDS || process.env.POLL_INTERVAL_SECONDS || '120', 10);
const POLL_INTERVAL_SCHEDULER_SECONDS = parseInt(process.env.POLL_INTERVAL_SCHEDULER_SECONDS || process.env.POLL_INTERVAL_SECONDS || '120', 10);
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

async function fetchDueSchedules(limit: number) {
  return pRetry(async () => {
    const resp = await axiosClient.get(`/scheduling/due?limit=${limit}`);
    if (!(resp && resp.status >= 200 && resp.status < 300)) {
      const err: any = new Error(`Unexpected status ${(resp as any).status}`);
      err.response = resp;
      throw err;
    }
    return (resp as any).data;
  }, { retries: 2 });
}

async function triggerSchedule(requestId: string, scheduledAt: string) {
  return pRetry(async () => {
    const resp = await axiosClient.post('/scheduling/request', { testExecutionRequestId: requestId, scheduledAt });
    if (!(resp && resp.status >= 200 && resp.status < 300)) {
      const err: any = new Error(`Unexpected status ${(resp as any).status}`);
      err.response = resp;
      throw err;
    }
    return (resp as any).data;
  }, { retries: 2 });
}

async function runBillingOnce() {
  try {
    console.info(`[scheduler] Polling for pending billing events (limit=${BATCH_SIZE})`);
    const resp = await processPending(BATCH_SIZE);
    console.info('[scheduler] processPending response:', resp);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    try {
      // Axios AggregateError or AxiosError may contain useful fields
      const e: any = err;
      if (e?.response) {
        console.error('[scheduler] Error during run - response error:', {
          message: e.message,
          code: e.code,
          status: e.response?.status,
          data: e.response?.data
        });
      } else if (e?.request) {
        console.error('[scheduler] Error during run - no response received:', { message: e.message, code: e.code });
      } else if (Array.isArray(e?.errors)) {
        console.error('[scheduler] Error during run - aggregate errors:', e.errors.map((x: any) => ({ message: x?.message, code: x?.code })));
      } else {
        console.error('[scheduler] Error during run:', e && e.stack ? e.stack : e);
      }
    } catch (logErr) {
      console.error('[scheduler] Error during run (failed to format):', err);
    }
  }
}

async function runSchedulesOnce() {
  try {
    console.info(`[scheduler] Polling for due schedules (limit=${BATCH_SIZE})`);
    const due = await fetchDueSchedules(BATCH_SIZE);
    console.info('[scheduler] due schedules:', due);
    for (const item of due || []) {
      try {
        const result = await triggerSchedule(item.id, item.nextRunAt);
        console.info(`[scheduler] Triggered schedule ${item.id}:`, result);
      } catch (err) {
        console.error('[scheduler] Failed to trigger schedule', item.id, (err as any) && (err as any).message ? (err as any).message : err);
      }
    }
  } catch (err) {
    console.error('[scheduler] Error fetching/trigerring schedules:', (err as any) && (err as any).message ? (err as any).message : err);
  }
}

async function start() {
  console.info(`[scheduler] Starting scheduler: billing every ${POLL_INTERVAL_BILLING_SECONDS}s, schedules every ${POLL_INTERVAL_SCHEDULER_SECONDS}s`);
  await initPRetry();
  // run each once immediately
  await Promise.all([runBillingOnce(), runSchedulesOnce()]);
  setInterval(runBillingOnce, POLL_INTERVAL_BILLING_SECONDS * 1000);
  setInterval(runSchedulesOnce, POLL_INTERVAL_SCHEDULER_SECONDS * 1000);
}

start().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[scheduler] Unhandled error starting scheduler:', err && err.stack ? err.stack : err);
  process.exit(1);
});
