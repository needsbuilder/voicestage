/**
 * A question from an MCP server (form elicitation), shown on the device
 * screen. One choice field becomes a set of large buttons, answered with one
 * tap; anything else becomes a short form. The same question can be answered
 * by voice: the next thing the person says is taken as the answer.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { formFields, type FormField } from '../../../src/shared/speech';
import type { JsonObject, PendingElicitation } from '../../../src/shared/types';
import { api } from '../api';
import { showToast } from '../store';

function initial(fields: FormField[]): JsonObject {
  const values: JsonObject = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    else if (field.type === 'boolean') values[field.key] = false;
    else if (field.type === 'multi') values[field.key] = [];
  }
  return values;
}

export function QuestionForm({ deviceId, question }: { deviceId: string; question: PendingElicitation }) {
  const fields = useMemo(() => formFields(question.requestedSchema), [question.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<JsonObject>(() => initial(fields));
  const [busy, setBusy] = useState(false);
  const single = fields.length === 1 && fields[0]!.type === 'choice' ? fields[0]! : undefined;

  const send = (action: 'accept' | 'decline', content?: JsonObject) => {
    setBusy(true);
    api.answer(deviceId, question.id, action, content).catch((error: unknown) => {
      setBusy(false);
      showToast(error instanceof Error ? error.message : String(error));
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content: JsonObject = {};
    for (const field of fields) {
      const value = values[field.key];
      if (value === undefined || value === '') continue;
      content[field.key] = field.type === 'number' ? Number(value) : value;
    }
    send('accept', content);
  };

  return (
    <section className="question" aria-labelledby={`q-${question.id}`}>
      <p className="question__eyebrow">A quick question</p>
      <h2 id={`q-${question.id}`}>{question.message}</h2>
      {single ? (
        <div className="question__choices" role="group" aria-label={single.title}>
          {(single.options ?? []).map((option) => (
            <button key={option.value} type="button" disabled={busy} onClick={() => send('accept', { [single.key]: option.value })}>
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <form className="question__form" onSubmit={submit}>
          {fields.map((field) => (
            <label key={field.key}>
              <span>
                {field.title}
                {field.required ? '' : ' (optional)'}
              </span>
              {field.type === 'choice' ? (
                <select value={String(values[field.key] ?? '')} required={field.required} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
                  <option value="">Choose...</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === 'multi' ? (
                <span className="question__checks">
                  {(field.options ?? []).map((option) => {
                    const chosen = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : [];
                    return (
                      <label key={option.value}>
                        <input
                          type="checkbox"
                          checked={chosen.includes(option.value)}
                          onChange={(event) => setValues({ ...values, [field.key]: event.target.checked ? [...chosen, option.value] : chosen.filter((item) => item !== option.value) })}
                        />
                        {option.label}
                      </label>
                    );
                  })}
                </span>
              ) : field.type === 'boolean' ? (
                <input type="checkbox" checked={values[field.key] === true} onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })} />
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  step={field.integer ? 1 : 'any'}
                  required={field.required}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                />
              )}
              {field.description && <small>{field.description}</small>}
            </label>
          ))}
          <button type="submit" className="question__submit" disabled={busy}>
            Answer
          </button>
        </form>
      )}
      <p className="question__foot">
        <span>You can also just say your answer.</span>
        <button type="button" className="link" disabled={busy} onClick={() => send('decline')}>
          Skip this question
        </button>
      </p>
    </section>
  );
}
