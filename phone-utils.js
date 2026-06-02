/**
 * Indian phone normalization and multi-number parsing (sheet cells: 91…, +91…, 930…/862…).
 */

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

function digitsOnly(raw) {
  return String(raw || '').replace(/[^0-9+]/g, '');
}

function normalizeIndianPhone(raw) {
  const d = digitsOnly(raw);
  if (!d) return null;

  if (d.startsWith('+')) {
    if (d.startsWith('+91') && d.length === 13) {
      const local = d.slice(3);
      return INDIAN_MOBILE.test(local) ? d : null;
    }
    if (d.length >= 11 && d.length <= 15) return d;
    return null;
  }

  if (d.length === 12 && d.startsWith('91')) {
    const local = d.slice(2);
    return INDIAN_MOBILE.test(local) ? `+91${local}` : null;
  }

  if (d.length === 11 && d.startsWith('0')) {
    const local = d.slice(1);
    return INDIAN_MOBILE.test(local) ? `+91${local}` : null;
  }

  if (d.length === 10 && INDIAN_MOBILE.test(d)) return `+91${d}`;

  return null;
}

/** Split cell text into unique normalized numbers. */
function parsePhoneList(raw) {
  if (raw == null || String(raw).trim() === '') return [];

  const parts = String(raw)
    .split(/[/|,;|\n|]+|\s+(?:or|and)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const n = normalizeIndianPhone(part);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function formatForDisplay(e164) {
  if (e164.startsWith('+91') && e164.length === 13) {
    return e164.slice(3);
  }
  return e164;
}

const phoneUtils = {
  digitsOnly,
  normalizeIndianPhone,
  parsePhoneList,
  formatForDisplay,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = phoneUtils;
}
if (typeof window !== 'undefined') {
  window.PhoneUtils = phoneUtils;
}
