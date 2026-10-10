/** Draws the default card: the view model from `buildDefaultCard`, for tool results without a card of their own. */
import { useMemo } from 'react';
import { buildDefaultCard } from '../../../src/shared/default-card';
import type { ScreenContent } from '../../../src/shared/types';

export function DefaultCardView({ screen }: { screen: ScreenContent }) {
  const card = useMemo(
    () => buildDefaultCard({ toolName: screen.tool.name, toolTitle: screen.tool.title, result: screen.result, locale: 'en-US' }),
    [screen.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return (
    <article className={`default-card default-card--${card.tone}`} aria-label={card.title}>
      <header>
        <p className="default-card__eyebrow">{card.eyebrow}</p>
        <h2>{card.title}</h2>
        {card.badges.length > 0 && (
          <p className="default-card__badges">
            {card.badges.map((badge) => (
              <span key={badge.label} className={`badge badge--${badge.tone}`}>
                {badge.label}
              </span>
            ))}
          </p>
        )}
      </header>
      {card.body && <p className="default-card__body">{card.body}</p>}
      {card.facts.length > 0 && (
        <dl className="default-card__facts">
          {card.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.sections.length > 0 && (
        <div className="default-card__sections">
          {card.sections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              {section.facts && (
                <dl className="default-card__facts">
                  {section.facts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {section.items && (
                <ul>
                  {section.items.map((item, index) => (
                    <li key={index}>
                      <span>{item.primary}</span>
                      {item.secondary && <small>{item.secondary}</small>}
                    </li>
                  ))}
                  {section.more ? <li className="default-card__more">and {section.more} more</li> : null}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </article>
  );
}
