/**
 * First-run hero: explains the app while the database is empty, above the
 * import controls. Screenshots come from `npm run screenshots` (fake data);
 * import.meta.glob keeps the build working even before they exist.
 */
const images = import.meta.glob<string>('./hero/*.webp', { eager: true, query: '?url', import: 'default' });

const SHOTS: Array<[file: string, caption: string, alt: string]> = [
  ['import', 'Import your statement', 'Import screen confirming 57 transactions were added and the totals match the statement'],
  ['transactions', 'Every payment, categorised', 'Transactions list with each payment tagged by category'],
  ['summary', 'See where it went', 'Summary screen with money in, money out and spending by category'],
];

const POINTS: Array<[icon: string, title: string, body: string]> = [
  ['🔒', 'Never uploaded', 'The PDF and your data stay on this phone.'],
  ['✓', 'Checked to the cent', "Totals are matched against the statement's own TOTAL row."],
  ['✎', 'Teach it once', 'Recategorise one payee and all the similar ones follow.'],
];

export function Hero({ onStart }: { onStart: () => void }) {
  const shots = SHOTS.map(([file, caption, alt]) => ({ src: images[`./hero/${file}.webp`], caption, alt })).filter(
    (s) => s.src,
  );

  return (
    <section class="hero">
      <h2 class="hero-title">See where your M-PESA money goes.</h2>
      <p class="hero-sub">
        Import your Safaricom statement PDF and every transaction is sorted into categories: food, bills, transport,
        Fuliza and more.
      </p>
      <ul class="hero-points">
        {POINTS.map(([icon, title, body]) => (
          <li key={title}>
            <span class="hero-icon" aria-hidden="true">
              {icon}
            </span>
            <span>
              <b>{title}</b>
              <span class="muted"> {body}</span>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" class="btn primary hero-cta" onClick={onStart}>
        Import a statement
      </button>
      {shots.length > 0 && (
        <div class="hero-shots">
          {shots.map((s) => (
            <figure key={s.caption}>
              <div class="phone">
                <img src={s.src} alt={s.alt} width={390} height={844} loading="lazy" decoding="async" />
              </div>
              <figcaption>{s.caption}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
