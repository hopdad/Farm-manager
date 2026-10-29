import { startVendorSim } from '../src/sim/vendors/server';
import { createStubSimWorld } from '../src/sim/vendors/stub-world';
const t = () => performance.now();
const s0 = t();
const sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0 });
console.log('start', (t() - s0).toFixed(1), sim.url);
async function post(p: string, body: unknown) {
  const a = t();
  const r = await fetch(`${sim.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const fetched = t() - a;
  await r.text();
  console.log(p, JSON.stringify(body).slice(0, 60), 'headers', fetched.toFixed(1), 'total', (t() - a).toFixed(1), 'ms');
}
for (let i = 0; i < 3; i++) {
  const a = t(); await (await fetch(`${sim.url}/_control/status`)).text(); console.log('GET status', (t() - a).toFixed(1));
  await post('/_control/clock', { action: 'pause' });
  await post('/_control/clock', { action: 'resume' });
  await post('/_control/clock', { action: 'jump', simTime: '2026-10-15T15:00:00Z' });
  await post('/_control/scenario', { scenario: 'bad-morning' });
  await post('/_control/faults', { action: 'add', rule: { id: 'down', vendor: 'samsara', kind: 'outage' } });
  const b = t();
  try { await fetch(`${sim.url}/samsara/fleet/vehicles/locations/feed`, { headers: { authorization: 'Bearer sim-samsara-token' } }); console.log('outage fetch RESOLVED (bad)', (t() - b).toFixed(1)); }
  catch (e) { console.log('outage fetch rejected (good)', (t() - b).toFixed(1), (e as Error).message); }
  await post('/_control/reset', { scenario: 'harvest-day' });
}
await sim.close();
console.log('closed');
