import { describe, expect, it } from 'vitest';
import { getPath, matchValue, renderString, renderText, renderValue, TemplateError } from '../src/shared/template.js';

const vars = { check: { check_id: 'chk_1', amount_usd: 182.4, payee: { status: 'verified' } }, inbox: { holds: [{ hold_id: 'hold_a' }, { hold_id: 'hold_b' }] }, empty: '' };

describe('templates', () => {
  it('reads values by dot path, including array indexes', () => {
    expect(getPath(vars, 'check.payee.status')).toBe('verified');
    expect(getPath(vars, 'inbox.holds.1.hold_id')).toBe('hold_b');
    expect(getPath(vars, 'inbox.holds.last.hold_id')).toBe('hold_b');
    expect(getPath(vars, 'inbox.holds.7.hold_id')).toBeUndefined();
    expect(getPath(vars, 'nope.deeper')).toBeUndefined();
  });

  it('keeps the type of a value when the string is one placeholder', () => {
    expect(renderString('{{check.amount_usd}}', vars)).toBe(182.4);
    expect(renderString('{{ inbox.holds.0 }}', vars)).toEqual({ hold_id: 'hold_a' });
    expect(renderString('Pay {{check.amount_usd}} now', vars)).toBe('Pay 182.4 now');
  });

  it('fills placeholders anywhere in a JSON value', () => {
    expect(renderValue({ hold_id: '{{inbox.holds.0.hold_id}}', note: 'For {{check.check_id}}', list: ['{{check.amount_usd}}'], keep: 3 }, vars)).toEqual({ hold_id: 'hold_a', note: 'For chk_1', list: [182.4], keep: 3 });
  });

  it('supports fallbacks and literal defaults', () => {
    expect(renderString('{{nope.x | check.check_id}}', vars)).toBe('chk_1');
    expect(renderString('{{nope.x | "someone"}}', vars)).toBe('someone');
    expect(renderText('Hello {{nope.x}}  there', vars)).toBe('Hello there');
  });

  it('throws in strict mode when nothing is saved under a name', () => {
    expect(() => renderValue({ id: '{{hold.hold_id}}' }, vars, true)).toThrow(TemplateError);
    expect(() => renderValue({ id: '{{hold.hold_id}}' }, vars, true)).toThrow(/Nothing is saved under "hold.hold_id"/);
  });
});

describe('matching', () => {
  it('matches objects partially and by dot path', () => {
    const actual = { verdict: 'stop', payee: { status: 'mismatch', name: 'IRS' }, holds: [{ blocked: true }] };
    expect(matchValue(actual, { verdict: 'stop' })).toBeUndefined();
    expect(matchValue(actual, { 'payee.status': 'mismatch', 'holds.0.blocked': true })).toBeUndefined();
    expect(matchValue(actual, { payee: { name: 'IRS' } })).toBeUndefined();
    expect(matchValue(actual, { verdict: 'verified' })).toBe('verdict is "stop", expected "verified"');
    expect(matchValue(actual, { 'payee.status': 'verified' })).toMatch(/payee.status is "mismatch"/);
    expect(matchValue(undefined, { a: 1 })).toMatch(/expected an object/);
  });

  it('understands comparison operators', () => {
    expect(matchValue('Sarah has answered', { contains: 'sarah' })).toBeUndefined();
    expect(matchValue(['a', 'b'], { contains: 'b' })).toBeUndefined();
    expect(matchValue('SIM-12AB', { matches: '^sim-' })).toBeUndefined();
    expect(matchValue(5, { gte: 5, lt: 6 })).toBeUndefined();
    expect(matchValue(5, { gt: 5 })).toMatch(/expected gt 5/);
    expect(matchValue([1, 2], { length: 2 })).toBeUndefined();
    expect(matchValue('x', { one_of: ['x', 'y'] })).toBeUndefined();
    expect(matchValue('z', { one_of: ['x', 'y'] })).toMatch(/not one of/);
    expect(matchValue(undefined, { exists: false })).toBeUndefined();
    expect(matchValue(undefined, { exists: true })).toMatch(/is missing/);
    expect(matchValue('a', { not: 'b' })).toBeUndefined();
    expect(matchValue('a', { not: 'a' })).toMatch(/should not be/);
    expect(matchValue({ count: 2 }, { count: { gte: 1 } })).toBeUndefined();
  });

  it('matches arrays element by element', () => {
    expect(matchValue([1, { a: 1, b: 2 }], [1, { a: 1 }])).toBeUndefined();
    expect(matchValue([1], [1, 2])).toMatch(/has 1 items, expected 2/);
    expect(matchValue('x', [1])).toMatch(/expected an array/);
  });
});
