import { describe, expect, it } from 'vitest';
import { cardCsp, withCsp } from '../src/shared/card-html.js';
import { buildDefaultCard, formatDuration, formatValue, humanizeKey, toneOf } from '../src/shared/default-card.js';

describe('default card', () => {
  it('builds a card from structured content: title, body, badge, facts, and lists', () => {
    const card = buildDefaultCard({
      toolName: 'find_recipe',
      toolTitle: 'Find a recipe',
      result: {
        content: [{ type: 'text', text: 'ignored when there is structured content' }],
        structuredContent: {
          title: 'Pancakes',
          say_to_user: 'Pancakes takes about 20 minutes.',
          serves: 4,
          minutes: 20,
          vegetarian: true,
          ingredients: ['Flour', 'Milk', 'Egg', 'Butter', 'Sugar', 'Salt', 'Baking powder'],
          steps: ['Mix.', 'Cook.'],
        },
      },
    });
    expect(card).toMatchObject({ tone: 'neutral', eyebrow: 'Find a recipe', title: 'Pancakes', body: 'Pancakes takes about 20 minutes.', textOnly: false });
    expect(card.facts).toEqual([
      { label: 'Serves', value: '4' },
      { label: 'Minutes', value: '20 min' },
      { label: 'Vegetarian', value: 'Yes' },
      { label: 'Steps', value: 'Mix., Cook.' },
    ]);
    expect(card.sections).toEqual([{ title: 'Ingredients', items: [{ primary: 'Flour' }, { primary: 'Milk' }, { primary: 'Egg' }, { primary: 'Butter' }, { primary: 'Sugar' }, { primary: 'Salt' }], more: 1 }]);
  });

  it('turns a status into a badge and a tone, formats money and dates, and puts ids last', () => {
    const card = buildDefaultCard({
      toolName: 'orders__get_order',
      result: { structuredContent: { order_id: 'ord_1', status: 'pending_review', amount_usd: 1500, shipping_usd: 4.5, placed_at: '2026-10-11T15:04:00Z', due: '2026-10-20', customer: { name: 'Ada', tier: 'gold' }, simulated: true } },
      locale: 'en-US',
      timeZone: 'UTC',
    });
    expect(card.title).toBe('Get order');
    expect(card.tone).toBe('caution');
    expect(card.badges).toEqual([
      { label: 'Pending review', tone: 'caution' },
      { label: 'Simulated', tone: 'neutral' },
    ]);
    expect(card.facts).toEqual([
      { label: 'Amount', value: '$1,500' },
      { label: 'Shipping', value: '$4.50' },
      { label: 'Placed', value: 'Oct 11, 2026, 3:04 PM' },
      { label: 'Due', value: 'Oct 20, 2026' },
      { label: 'Order ID', value: 'ord_1' },
      { label: 'Simulated', value: 'Yes' },
    ]);
    expect(card.sections).toEqual([{ title: 'Customer', facts: [{ label: 'Name', value: 'Ada' }, { label: 'Tier', value: 'Gold' }] }]);
  });

  it('lists arrays of objects by their name, with a couple of details each', () => {
    const card = buildDefaultCard({
      toolName: 'list_holds',
      result: { structuredContent: { count: 2, holds: [{ hold_id: 'hold_1', payee_name: 'Con Edison', status: 'approved', amount_usd: 182.4 }, { hold_id: 'hold_2', payee_name: 'Greenleaf Roofing', status: 'pending_family' }] } },
    });
    expect(card.sections[0]).toEqual({
      title: 'Holds',
      items: [
        { primary: 'Con Edison', secondary: 'Approved · $182.40 · Hold ID: hold_1' },
        { primary: 'Greenleaf Roofing', secondary: 'Pending family · Hold ID: hold_2' },
      ],
      more: undefined,
    });
  });

  it('unwraps a result that is one object inside a single key', () => {
    const card = buildDefaultCard({ toolName: 'get_circle', result: { structuredContent: { circle: { name: 'Ellis family', members: [{ name: 'Margaret' }] } } } });
    expect(card.title).toBe('Ellis family');
    expect(card.sections[0]).toMatchObject({ title: 'Members', items: [{ primary: 'Margaret' }] });
  });

  it('shows an error result plainly, with the error code as a badge', () => {
    const card = buildDefaultCard({ toolName: 'pay', toolTitle: 'Make the payment', result: { isError: true, content: [{ type: 'text', text: 'Error (not_approved): This payment is still waiting for an answer.' }] } });
    expect(card).toMatchObject({ tone: 'stop', title: "That didn't work", body: 'This payment is still waiting for an answer.', badges: [{ label: 'Not approved', tone: 'stop' }], textOnly: true });
  });

  it('falls back to the text when there is no structured content', () => {
    expect(buildDefaultCard({ toolName: 'tell_joke', result: { content: [{ type: 'text', text: 'Why did the scarecrow win an award?\n\nHe was outstanding in his field.' }] } })).toMatchObject({ title: 'Why did the scarecrow win an award?', body: 'He was outstanding in his field.', textOnly: true });
    expect(buildDefaultCard({ toolName: 'ping', result: { content: [] } })).toMatchObject({ title: 'Ping', body: 'Done.' });
    expect(buildDefaultCard({ toolName: 'ping', result: { structuredContent: {} } })).toMatchObject({ title: 'Ping', textOnly: true });
  });

  it('formats values and names', () => {
    expect(humanizeKey('amount_usd')).toBe('Amount');
    expect(humanizeKey('payeeName')).toBe('Payee Name');
    expect(humanizeKey('hold_id')).toBe('Hold ID');
    expect(formatValue('waited_seconds', 95)).toBe('1 min 35 sec');
    expect(formatValue('total', 12.5)).toBe('$12.50');
    expect(formatValue('tags', ['fresh', 'gluten_free'])).toBe('Fresh, Gluten free');
    expect(formatValue('receipt_id', 'rcpt_x9')).toBe('rcpt_x9');
    expect(formatValue('note', 'hold_1')).toBe('hold_1');
    expect(formatValue('x', null)).toBeUndefined();
    expect(formatDuration(3600)).toBe('1 hr');
    expect(toneOf('approved')).toBe('good');
    expect(toneOf('pending_family')).toBe('caution');
    expect(toneOf('denied')).toBe('stop');
    expect(toneOf('whatever')).toBe('neutral');
  });
});

describe('card sandbox policy', () => {
  it('denies everything a card did not ask for', () => {
    expect(cardCsp(undefined)).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
  });

  it('allows the origins a card declares, and drops anything that is not an origin', () => {
    const csp = cardCsp({ connectDomains: ['https://api.example.com', "'unsafe-eval'; script-src *"], resourceDomains: ['https://cdn.example.com'] });
    expect(csp).toContain('connect-src https://api.example.com;');
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
    expect(csp).toContain('img-src data: blob: https://cdn.example.com;');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('puts the policy at the very start of the document head', () => {
    expect(withCsp('<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>', undefined)).toMatch(/^<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><title>x<\/title>/);
    expect(withCsp('<html><body>x</body></html>', undefined)).toMatch(/^<html><head><meta http-equiv/);
    expect(withCsp('<p>x</p>', undefined)).toMatch(/^<meta http-equiv[^>]+><p>x<\/p>$/);
  });
});
