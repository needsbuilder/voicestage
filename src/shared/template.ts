/**
 * Small helpers for reading values out of JSON by path and filling `{{ ... }}`
 * placeholders. Used by scenario files and announcement rules.
 *
 * A path is dot separated; numbers index arrays: `inbox.holds.0.hold_id`.
 * A string that is exactly one placeholder keeps the value's type, so
 * `amount: "{{check.amount_usd}}"` yields a number.
 */

export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    const key = part.trim();
    if (key === '') continue;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = key === 'last' ? current.length - 1 : Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export class TemplateError extends Error {}

function resolve(expression: string, vars: Record<string, unknown>, strict: boolean): unknown {
  // `a.b | c.d` falls back to the next path; a quoted last part is a literal default.
  const options = expression.split('|').map((part) => part.trim());
  for (const option of options) {
    const literal = /^(["'])(.*)\1$/.exec(option);
    if (literal) return literal[2];
    const value = getPath(vars, option);
    if (value !== undefined && value !== null) return value;
  }
  if (strict) throw new TemplateError(`Nothing is saved under "${expression}".`);
  return undefined;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Fill placeholders in a string. With `strict`, a missing value throws instead of becoming "". */
export function renderString(template: string, vars: Record<string, unknown>, strict = false): unknown {
  const whole = WHOLE.exec(template);
  if (whole) return resolve(whole[1]!, vars, strict);
  return template.replace(PLACEHOLDER, (_match, expression: string) => stringify(resolve(expression, vars, strict)));
}

/** Fill placeholders anywhere inside a JSON value. */
export function renderValue<T>(value: T, vars: Record<string, unknown>, strict = false): T {
  if (typeof value === 'string') return renderString(value, vars, strict) as T;
  if (Array.isArray(value)) return value.map((item) => renderValue(item, vars, strict)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, vars, strict)])) as T;
  }
  return value;
}

export function renderText(template: string, vars: Record<string, unknown>, strict = false): string {
  return stringify(renderString(template, vars, strict)).replace(/\s+/g, ' ').trim();
}

/**
 * Compare an actual value with an expected one, loosely enough for scenario
 * files: objects match when every expected key matches (extra keys are fine),
 * arrays match element by element, and a few operator objects are understood:
 * `{ contains: "x" }`, `{ matches: "regex" }`, `{ exists: true }`,
 * `{ one_of: [...] }`, `{ gt | gte | lt | lte: n }`, `{ length: n }`.
 */
export function matchValue(actual: unknown, expected: unknown, path = ''): string | undefined {
  const where = path || 'value';
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const spec = expected as Record<string, unknown>;
    const keys = Object.keys(spec);
    const operators = ['contains', 'matches', 'exists', 'one_of', 'gt', 'gte', 'lt', 'lte', 'length', 'not'];
    if (keys.length > 0 && keys.every((key) => operators.includes(key))) {
      for (const key of keys) {
        const want = spec[key];
        if (key === 'exists') {
          const present = actual !== undefined && actual !== null;
          if (present !== Boolean(want)) return `${where} ${want ? 'is missing' : `should be absent but is ${JSON.stringify(actual)}`}`;
        } else if (key === 'contains') {
          if (Array.isArray(actual)) {
            if (!actual.some((item) => matchValue(item, want) === undefined)) return `${where} does not contain ${JSON.stringify(want)}`;
          } else if (!String(actual ?? '').toLowerCase().includes(String(want).toLowerCase())) {
            return `${where} is ${JSON.stringify(actual)}, which does not contain ${JSON.stringify(want)}`;
          }
        } else if (key === 'matches') {
          if (!new RegExp(String(want), 'i').test(String(actual ?? ''))) return `${where} is ${JSON.stringify(actual)}, which does not match /${String(want)}/`;
        } else if (key === 'one_of') {
          if (!Array.isArray(want) || !want.some((item) => matchValue(actual, item) === undefined)) return `${where} is ${JSON.stringify(actual)}, not one of ${JSON.stringify(want)}`;
        } else if (key === 'length') {
          const length = Array.isArray(actual) || typeof actual === 'string' ? actual.length : undefined;
          if (length !== want) return `${where} has length ${length}, expected ${String(want)}`;
        } else if (key === 'not') {
          if (matchValue(actual, want, path) === undefined) return `${where} should not be ${JSON.stringify(want)}`;
        } else {
          const number = typeof actual === 'number' ? actual : Number.NaN;
          const limit = Number(want);
          const ok = key === 'gt' ? number > limit : key === 'gte' ? number >= limit : key === 'lt' ? number < limit : number <= limit;
          if (!ok) return `${where} is ${JSON.stringify(actual)}, expected ${key} ${limit}`;
        }
      }
      return undefined;
    }
    if (actual === null || typeof actual !== 'object') return `${where} is ${JSON.stringify(actual)}, expected an object`;
    for (const key of keys) {
      // A key may itself be a dot path, which keeps scenario files flat.
      const failure = matchValue(getPath(actual, key), spec[key], path ? `${path}.${key}` : key);
      if (failure) return failure;
    }
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${where} is ${JSON.stringify(actual)}, expected an array`;
    if (actual.length !== expected.length) return `${where} has ${actual.length} items, expected ${expected.length}`;
    for (let index = 0; index < expected.length; index += 1) {
      const failure = matchValue(actual[index], expected[index], `${where}.${index}`);
      if (failure) return failure;
    }
    return undefined;
  }
  if (actual !== expected) return `${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
  return undefined;
}
