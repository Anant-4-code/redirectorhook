/**
 * Google Apps Script — encrypted CallBridge links (number hidden from URL)
 *
 * Setup:
 * 1. Railway → Variables → SHEET_API_KEY = your-random-secret
 * 2. Extensions → Apps Script → paste this file
 * 3. Set CALLBRIDGE_URL and SHEET_API_KEY below
 * 4. In sheet cell: =CALLBRIDGE_LINK("rahul", B2)
 */

const CALLBRIDGE_URL = 'https://redirectorhook-production.up.railway.app';
const SHEET_API_KEY = 'YOUR-SHEET-API-KEY'; // same as Railway SHEET_API_KEY
const AGENT_NAME = 'rahul'; // or pass per-row

/**
 * Encrypted call link — URL contains no plain phone number.
 * @param {string} agentId Agent name (e.g. rahul)
 * @param {string|number} number Phone number from cell
 * @return {string} Full HTTPS URL with encrypted ?e= parameter
 */
function CALLBRIDGE_LINK(agentId, number) {
  if (!number) return '';

  const payload = JSON.stringify({
    agentId: agentId || AGENT_NAME,
    number: String(number).replace(/[^0-9+]/g, ''),
  });

  const res = UrlFetchApp.fetch(CALLBRIDGE_URL + '/encrypt', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Key': SHEET_API_KEY },
    payload: payload,
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Encrypt failed: ' + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  return data.url;
}

/**
 * Hyperlink formula helper for Google Sheets.
 * =HYPERLINK(CALLBRIDGE_LINK("rahul", B2), "📞 Call")
 */
function CALLBRIDGE_HYPERLINK(agentId, number, label) {
  const url = CALLBRIDGE_LINK(agentId, number);
  return url ? '=HYPERLINK("' + url + '","' + (label || '📞 Call') + '")' : '';
}
