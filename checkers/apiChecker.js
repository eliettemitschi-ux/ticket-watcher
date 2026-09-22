// apiChecker.js
//
// Lightweight checker for events where discover.js managed to find the
// underlying JSON endpoint the ticket widget itself calls (this is the
// happy path -- a plain HTTPS GET every poll, no browser needed). See
// checkers/renderChecker.js for the fallback used when no such endpoint
// was found.

const fetch = require('node-fetch');

// Resolves a dotted/bracketed path like "instances[0].available" against
// an object. Deliberately tiny -- avoids pulling in lodash for one function.
function getByPath(obj, pathStr) {
  if (!pathStr) return obj;
  const parts = pathStr
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Turns the resolved value into a sold_out/available verdict using the
// recipe's `availableWhen` rule, falling back to sensible defaults for
// plain booleans and numbers when no rule is given.
function evaluate(value, availableWhen) {
  if (availableWhen) {
    switch (availableWhen.type) {
      case 'truthy':
        return Boolean(value);
      case 'falsy':
        return !value;
      case 'gt':
        return Number(value) > Number(availableWhen.value);
      case 'gte':
        return Number(value) >= Number(availableWhen.value);
      case 'equals':
        return value === availableWhen.value;
      case 'notEquals':
        return value !== availableWhen.value;
      case 'oneOf':
        return Array.isArray(availableWhen.value) && availableWhen.value.includes(value);
      default:
        break;
    }
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return undefined; // genuinely can't tell -- caller should treat as unknown
}

/**
 * @param {object} recipe { apiUrl, method='GET', headers, jsonPath, availableWhen }
 * @returns {Promise<{state: 'sold_out'|'available'|'unknown'|'error', raw: any, snippet: string|null, error?: string}>}
 */
async function checkApi(recipe) {
  try {
    const res = await fetch(recipe.apiUrl, {
      method: recipe.method || 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ticket-watcher/1.0; personal use)',
        ...(recipe.headers || {}),
      },
      timeout: 15000,
    });

    if (!res.ok) {
      return {
        state: 'error',
        raw: null,
        snippet: null,
        error: `HTTP ${res.status} from ${recipe.apiUrl}`,
      };
    }

    const json = await res.json();
    const value = getByPath(json, recipe.jsonPath);
    const available = evaluate(value, recipe.availableWhen);

    return {
      state: available === undefined ? 'unknown' : available ? 'available' : 'sold_out',
      raw: json,
      snippet: JSON.stringify(value),
    };
  } catch (err) {
    return { state: 'error', raw: null, snippet: null, error: err.message };
  }
}

module.exports = { checkApi, getByPath, evaluate };
