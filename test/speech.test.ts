import { describe, expect, it } from 'vitest';
import { answerFromSpeech, bestLineMatch, formFields, normalizeUtterance, questionForSpeech, utteranceSimilarity } from '../src/shared/speech.js';

describe('matching what was said against known lines', () => {
  it('normalises punctuation, case and money', () => {
    expect(normalizeUtterance("It's $2,000 in gift cards, today!")).toBe("it's 2000 dollars in gift cards today");
    expect(normalizeUtterance('It is $182.40.')).toBe('it is 182.40 dollars');
  });

  it('scores the same words highly whatever the punctuation', () => {
    expect(utteranceSimilarity('Pay my Con Edison bill, please.', 'pay my con edison bill please')).toBe(1);
    expect(utteranceSimilarity('Set a timer for the pancakes', 'What is the weather')).toBeLessThan(0.2);
  });

  it('finds the closest line when speech recognition gets a few words wrong', () => {
    const lines = [
      { text: 'How do I make pancakes?', item: 'recipe' },
      { text: 'Set a timer for the pancakes.', item: 'timer' },
      { text: "My Con Edison bill came in the mail. It's $182.40. Please pay it with my card.", item: 'bill' },
    ];
    expect(bestLineMatch('set a timer for pancakes', lines)?.item).toBe('timer');
    expect(bestLineMatch('how do i make the pancakes', lines)?.item).toBe('recipe');
    expect(bestLineMatch('my con edison bill came in the mail it is $182.40 please pay with my card', lines)?.item).toBe('bill');
    expect(bestLineMatch('tell me a joke', lines)).toBeUndefined();
  });
});

const choice = {
  type: 'object',
  properties: {
    contact_channel: {
      type: 'string',
      title: 'How did the request reach you?',
      oneOf: [
        { const: 'phone_call', title: 'Someone called me' },
        { const: 'text', title: 'I got a text message' },
        { const: 'mail', title: 'A letter or bill came in the mail' },
        { const: 'unknown', title: "It's my own idea, or I'm not sure" },
      ],
    },
  },
  required: ['contact_channel'],
};

describe('form elicitation', () => {
  it('turns a requested schema into fields', () => {
    expect(formFields(choice)).toEqual([
      {
        key: 'contact_channel',
        title: 'How did the request reach you?',
        description: undefined,
        required: true,
        defaultValue: undefined,
        type: 'choice',
        options: [
          { value: 'phone_call', label: 'Someone called me' },
          { value: 'text', label: 'I got a text message' },
          { value: 'mail', label: 'A letter or bill came in the mail' },
          { value: 'unknown', label: "It's my own idea, or I'm not sure" },
        ],
      },
    ]);
    const mixed = formFields({
      type: 'object',
      properties: {
        size: { type: 'string', enum: ['small', 'large'], enumNames: ['Small', 'Large'] },
        count: { type: 'integer', default: 1 },
        gift: { type: 'boolean', title: 'Is it a gift?' },
        note: { type: 'string', description: 'Anything else' },
        toppings: { type: 'array', items: { anyOf: [{ const: 'ham', title: 'Ham' }, { const: 'egg', title: 'Egg' }] } },
      },
      required: ['size'],
    });
    expect(mixed.map((field) => [field.key, field.type, field.required])).toEqual([
      ['size', 'choice', true],
      ['count', 'number', false],
      ['gift', 'boolean', false],
      ['note', 'text', false],
      ['toppings', 'multi', false],
    ]);
    expect(mixed[0]!.options).toEqual([
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ]);
    expect(mixed[1]).toMatchObject({ integer: true, defaultValue: 1, title: 'Count' });
  });

  it('answers a choice from natural speech', () => {
    const fields = formFields(choice);
    expect(answerFromSpeech(fields, 'Someone called me')).toEqual({ action: 'accept', content: { contact_channel: 'phone_call' } });
    expect(answerFromSpeech(fields, 'It was a phone call')).toEqual({ action: 'accept', content: { contact_channel: 'phone_call' } });
    expect(answerFromSpeech(fields, 'it came in the mail')).toEqual({ action: 'accept', content: { contact_channel: 'mail' } });
    expect(answerFromSpeech(fields, 'I got a text')).toEqual({ action: 'accept', content: { contact_channel: 'text' } });
  });

  it('declines when the person does not want to answer, and asks again when unclear', () => {
    const fields = formFields(choice);
    expect(answerFromSpeech(fields, "never mind, I'd rather not say")).toEqual({ action: 'decline' });
    expect(answerFromSpeech(fields, 'purple elephants')).toMatchObject({ action: 'unclear' });
  });

  it('understands numbers, yes and no, and free text', () => {
    const duration = formFields({ type: 'object', properties: { duration: { type: 'string', oneOf: [{ const: '3', title: '3 seconds' }, { const: '60', title: '1 minute' }, { const: '180', title: '3 minutes' }] } }, required: ['duration'] });
    expect(answerFromSpeech(duration, 'three minutes')).toEqual({ action: 'accept', content: { duration: '180' } });
    expect(answerFromSpeech(duration, 'Three seconds')).toEqual({ action: 'accept', content: { duration: '3' } });
    expect(answerFromSpeech(duration, '3 minutes')).toEqual({ action: 'accept', content: { duration: '180' } });
    // The unit without the number is not an answer.
    expect(answerFromSpeech(duration, 'some minutes')).toMatchObject({ action: 'unclear' });
    expect(answerFromSpeech(duration, 'one minute, I mean 1 minute')).toEqual({ action: 'accept', content: { duration: '60' } });

    const number = formFields({ type: 'object', properties: { guests: { type: 'integer' } }, required: ['guests'] });
    expect(answerFromSpeech(number, 'about 4 people')).toEqual({ action: 'accept', content: { guests: 4 } });
    expect(answerFromSpeech(number, 'five')).toEqual({ action: 'accept', content: { guests: 5 } });

    const yesNo = formFields({ type: 'object', properties: { gift: { type: 'boolean' } }, required: ['gift'] });
    expect(answerFromSpeech(yesNo, "yes it's a gift")).toEqual({ action: 'accept', content: { gift: true } });
    expect(answerFromSpeech(yesNo, 'no')).toEqual({ action: 'accept', content: { gift: false } });

    const text = formFields({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
    expect(answerFromSpeech(text, 'Greenleaf Roofing')).toEqual({ action: 'accept', content: { name: 'Greenleaf Roofing' } });
    expect(answerFromSpeech(text, 'skip it')).toEqual({ action: 'decline' });
  });

  it('reads the choices aloud when there are few enough', () => {
    expect(questionForSpeech('How did this reach you?', formFields(choice))).toBe("How did this reach you? You can say: Someone called me, I got a text message, A letter or bill came in the mail, or It's my own idea, or I'm not sure.");
    expect(questionForSpeech('What is the name?', formFields({ type: 'object', properties: { name: { type: 'string' } } }))).toBe('What is the name?');
  });
});
