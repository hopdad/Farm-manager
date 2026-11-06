/** What a request link says when it can't take a request (revoked or unknown; the day's cap). */
import css from '../../login/login.module.css';

export function RefusedCard({ reason }: { reason: 'unknown' | 'limit' }) {
  return (
    <section
      className={`${css.card} ${css.narrow}`}
      data-testid="request-refused"
      data-reason={reason}
      role="alert"
    >
      {reason === 'unknown' ? (
        <>
          <h2 className={css.title}>This link doesn&apos;t work any more</h2>
          <p className={css.lead}>Call or text us, and we&apos;ll send you a new one.</p>
        </>
      ) : (
        <>
          <h2 className={css.title}>That&apos;s all the requests for today</h2>
          <p className={css.lead}>
            This link has taken all its requests for today. Call or text us, or try again tomorrow.
          </p>
        </>
      )}
    </section>
  );
}

export function RefusedView({ reason }: { reason: 'unknown' | 'limit' }) {
  return (
    <main className={css.page} data-testid="request-page">
      <span className={css.brand}>Farm Ops</span>
      <RefusedCard reason={reason} />
    </main>
  );
}
