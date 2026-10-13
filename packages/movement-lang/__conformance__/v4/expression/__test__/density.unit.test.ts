// The density estimate behind `CHUNKS(t, { entities: N })` — how many records
// a text is likely to yield. It is a HEURISTIC, so what is pinned here is the
// shape of the four corpora it was built for, not a figure to the record: a
// list of one-liners estimates about as many records as it has lines, a
// paragraph about one company estimates about one, and prose estimates a
// handful rather than a hundred.

import { estimateEntities, estimateEntitiesInLine } from '../density';

describe('a list of bracketed one-liners', () => {
  const feed = [
    '[Example Ventures · Funding] Acme Industrials raised a seed round — acme.example.com',
    '[Example Ventures · Funding] Northwind Logistics raised a Series A',
    '[Example Ventures · People] Jane Doe joined Acme Industrials as CFO',
    '[Example Ventures · Funding] Contoso Systems closed a bridge',
    '[Example Ventures · People] John Roe left Northwind Logistics',
    '[Example Ventures · Funding] Fabrikam Robotics raised a Series B',
    '[Example Ventures · Funding] Tailwind Foods raised a seed round',
    '[Example Ventures · People] Alex Stone joined Contoso Systems',
    '[Example Ventures · Funding] Blue Yonder Airlines raised a Series C',
    '[Example Ventures · People] Sam Reed joined Fabrikam Robotics',
    '[Example Ventures · Funding] Proseware Media raised a seed round',
    '[Example Ventures · Funding] Wingtip Toys raised a Series A',
    '[Example Ventures · People] Robin Fox joined Tailwind Foods',
    '[Example Ventures · Funding] Litware Analytics closed a bridge',
    '[Example Ventures · People] Casey Lane left Proseware Media',
  ].join('\n');

  it('estimates about one record per line', () => {
    expect(estimateEntities(feed)).toBe(15);
  });

  it('a tagged line carrying its own address is still one record', () => {
    expect(
      estimateEntitiesInLine('[Example Ventures · Funding] Acme Industrials — acme.example.com'),
    ).toBe(1);
  });

  it('a bulleted line is an item the same way', () => {
    expect(estimateEntitiesInLine('• Acme Industrials raised a seed round')).toBe(1);
  });
});

describe('a chatty paragraph about one company', () => {
  const paragraph =
    'Spent most of yesterday afternoon with the team at Acme Industrials, who are further ' +
    'along than the deck suggested — the pilot is live with two customers, the second one ' +
    'signed without a discount, and they are turning down the kind of consulting revenue ' +
    'that usually swallows a company at this stage. Their site is https://acme.example.com ' +
    'and the founders were straightforward about what is not working yet, which I liked.';

  it('estimates one record, not one per sentence', () => {
    expect(estimateEntities(paragraph)).toBe(1);
  });
});

describe('a message with three profile links', () => {
  const message =
    'Intros from the summit: https://www.linkedin.com/in/jane-doe-example, ' +
    'https://www.linkedin.com/in/john-roe-example and ' +
    'https://www.linkedin.com/in/alex-stone-example — all worth a call.';

  it('estimates one record per profile', () => {
    expect(estimateEntities(message)).toBe(3);
  });

  it('counts the same address written twice as one', () => {
    expect(
      estimateEntitiesInLine(
        'See https://www.linkedin.com/in/jane-doe-example (linkedin.com/in/jane-doe-example)',
      ),
    ).toBe(1);
  });

  it('counts a company page as a record too', () => {
    expect(
      estimateEntitiesInLine(
        'Both of them: linkedin.com/company/acme-industrials and linkedin.com/company/northwind-logistics',
      ),
    ).toBe(2);
  });
});

describe('plain prose naming two things', () => {
  const prose =
    'The meeting ran long and most of it was about hiring, which is not what I had gone ' +
    'in to talk about, but the interesting part came at the end when the conversation ' +
    'turned to who else is working on this. Acme Industrials came up twice, and so did ' +
    'Northwind Logistics, and the view was that neither of them has shipped anything a ' +
    'customer would pay for yet, which may or may not still be true by the autumn.';

  it('estimates the two proper nouns it names', () => {
    expect(estimateEntities(prose)).toBe(2);
  });

  it('does not count a single capitalised word as a name', () => {
    expect(estimateEntitiesInLine('Yesterday was quiet and nothing much happened at all.')).toBe(0);
  });

  it('damps prose that names far more things than it is about', () => {
    const crowded =
      'Last Tuesday in New York, Jane Doe, John Roe, Alex Stone, Sam Reed, Robin Fox and ' +
      'Casey Lane all said the same thing.';
    // Nine capitalised runs in 130-odd characters is a sentence, not a directory.
    expect(estimateEntities(crowded)).toBeLessThan(4);
  });
});

describe('a text with nothing in it', () => {
  it('estimates nothing', () => {
    expect(estimateEntities('')).toBe(0);
    expect(estimateEntities('   \n\n  ')).toBe(0);
  });
});
