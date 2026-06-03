/**
 * Optional in-process limits (CallBridge server only).
 * ntfy.sh free tier has its own quota — use self-hosted ntfy (NTFY_BASE_URL) for production.
 *
 * Env:
 *   MAX_CALLS_PER_SECOND — default 20 (set 0 to disable per-second cap)
 *   MAX_CALLS_PER_DAY    — default 25000 (set 0 to disable daily cap)
 *   ENABLE_CALL_LIMITS   — default "true"; set "false" to disable all caps here
 */

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

// Off by default — your team should not be blocked below ntfy.sh quotas.
const ENABLED = process.env.ENABLE_CALL_LIMITS === 'true';
const MAX_PER_SECOND = envInt('MAX_CALLS_PER_SECOND', 20);
const MAX_PER_DAY = envInt('MAX_CALLS_PER_DAY', 25000);

const secondBuckets = new Map();
let dayCount = 0;
let dayKey = todayKey();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pruneSecondBuckets(nowSec) {
  for (const [sec, count] of secondBuckets) {
    if (sec < nowSec - 2) secondBuckets.delete(sec);
  }
}

function checkCallLimit() {
  if (!ENABLED) return null;
  if (MAX_PER_SECOND <= 0 && MAX_PER_DAY <= 0) return null;

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const today = todayKey();

  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }

  if (MAX_PER_DAY > 0 && dayCount >= MAX_PER_DAY) {
    return {
      status: 429,
      error: 'Daily call limit reached on CallBridge server',
      detail: `Limit is ${MAX_PER_DAY} calls per day. Resets at midnight UTC. Set MAX_CALLS_PER_DAY=0 or use self-hosted ntfy.`,
    };
  }

  if (MAX_PER_SECOND > 0) {
    pruneSecondBuckets(nowSec);
    const secCount = (secondBuckets.get(nowSec) || 0) + 1;
    secondBuckets.set(nowSec, secCount);
    if (secCount > MAX_PER_SECOND) {
      return {
        status: 429,
        error: 'Too many calls per second',
        detail: `Limit is ${MAX_PER_SECOND} calls per second. Retry in 1 second.`,
      };
    }
  }

  dayCount += 1;
  return null;
}

function limitConfig() {
  return {
    enabled: ENABLED,
    maxPerSecond: MAX_PER_SECOND,
    maxPerDay: MAX_PER_DAY,
  };
}

module.exports = { checkCallLimit, limitConfig };
