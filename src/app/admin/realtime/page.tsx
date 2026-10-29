/**
 * /admin/realtime: realtime diagnostics. The client side shows what this tab receives; the
 * server side shows the LISTEN hub of this Next process (state, subscribers per topic).
 * `?topics=fleet,admin` picks the topics (default both).
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '@/config';
import { getRealtimeHub } from '@/platform/realtime/hub';
import { parseTopics } from '@/platform/realtime/sse';
import type { Topic } from '@/platform/realtime/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import { RealtimeMonitor } from '../_components/RealtimeMonitor';
import css from '../admin.module.css';
import { dropListenAction, sendTestEventAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Realtime · Farm Ops' };

export default async function RealtimePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.topics === 'string' ? sp.topics : 'admin,fleet';
  const parsed = parseTopics(raw);
  const topics = (parsed.ok ? parsed.topics : ['admin', 'fleet']) as Topic[];
  const cfg = getConfig();
  const hub = cfg.NEXT_PUBLIC_REALTIME === 'sse' ? getRealtimeHub().stats() : null;
  const marker = randomUUID();

  return (
    <NoticeProvider>
      <main>
        <div className={css.pageHead}>
          <h1>Realtime</h1>
          <span className={css.muted}>adapter {cfg.NEXT_PUBLIC_REALTIME}</span>
        </div>
        {!parsed.ok && <div className={css.banner}>{parsed.error}; showing admin,fleet</div>}
        <div className={css.grid}>
          <section className={css.card}>
            <h2>This tab</h2>
            <RealtimeMonitor topics={topics} />
          </section>
          <section className={css.card}>
            <h2>Server LISTEN hub</h2>
            {hub ? (
              <dl className={css.kv} data-testid="hub-stats">
                <dt>State</dt>
                <dd>{hub.state}</dd>
                <dt>Subscribers</dt>
                <dd data-testid="hub-subscribers">{hub.subscribers}</dd>
                <dt>By topic</dt>
                <dd className={css.mono}>
                  {Object.entries(hub.topics)
                    .map(([t, n]) => `${t}: ${n}`)
                    .join(', ') || '-'}
                </dd>
                <dt>Connects</dt>
                <dd>{hub.connects}</dd>
                <dt>Delivered</dt>
                <dd>{hub.delivered}</dd>
                <dt>Last error</dt>
                <dd className={hub.lastError ? css.error : undefined}>{hub.lastError ?? '-'}</dd>
              </dl>
            ) : (
              <p className={css.muted}>The SSE adapter is off (NEXT_PUBLIC_REALTIME=supabase).</p>
            )}
            <p className={css.muted}>
              Counts are for this Next process at render time; reload to update.
            </p>
            <h3>Try it</h3>
            <p className={css.muted}>
              Open this page on a phone too, then send a test event: every open screen shows it
              within a second or two.
            </p>
            <div className={css.row}>
              <ActionForm action={sendTestEventAction}>
                <input type="hidden" name="marker" value={marker} data-testid="test-marker" />
                <SubmitButton className={`${css.button} ${css.primary}`} testId="send-test-event">
                  Send a test event
                </SubmitButton>
              </ActionForm>
              {hub && !cfg.isProduction && (
                <ActionForm action={dropListenAction}>
                  <SubmitButton
                    testId="drop-listen"
                    title="what a database restart looks like: clients resync"
                  >
                    Drop the LISTEN connection
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          </section>
        </div>
      </main>
    </NoticeProvider>
  );
}
