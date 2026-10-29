/**
 * /admin/fields/new: draw a field that is not in Operations Center (a prospect, a customer's
 * field not in Ops Center): tap its corners on the map, name it, pick the farm. Its boundary is
 * the app's to edit (D6). Manager or owner only.
 */
import Link from 'next/link';
import { getPool } from '@/db/client';
import { listFarms } from '@/db/queries/boundaries-fields';
import { listParties } from '@/db/queries/parties';
import { ROLE_FOR } from '@/platform/auth/types';
import { localParts } from '@/sim/time';
import { loadMapPageData } from '@/ui/map/server/map-data';
import adminCss from '../../admin.module.css';
import { EditorLoader } from '../_components/EditorLoader';
import { NoAccess } from '../_components/NoAccess';
import { pageAccess } from '../_lib/access';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New field · Farm Ops' };

const pad = (n: number) => String(n).padStart(2, '0');

export default async function NewFieldPage() {
  const access = await pageAccess(ROLE_FOR.admin);
  if (!access.ok) return <NoAccess status={access.status} required={access.required} />;
  const pool = getPool();
  const [farms, parties, mapData] = await Promise.all([
    listFarms(pool),
    listParties(pool, { role: 'landlord' }),
    loadMapPageData(),
  ]);
  const p = localParts(Date.now());
  // Your own farms first (demo farms last).
  const sorted = [...farms].sort(
    (a, b) =>
      Number(a.source === 'demo') - Number(b.source === 'demo') || a.name.localeCompare(b.name),
  );
  return (
    <>
      <div className={adminCss.pageHead}>
        <h1>Draw a new field</h1>
        <Link href="/admin/fields" className={adminCss.navLink}>
          All fields
        </Link>
      </div>
      <EditorLoader
        data={mapData}
        field={null}
        adjacent={[]}
        today={`${p.y}-${pad(p.m)}-${pad(p.d)}`}
        farms={sorted.map((f) => ({ id: f.id, name: f.name }))}
        landlords={parties.map((x) => ({ id: x.id, displayName: x.displayName }))}
      />
    </>
  );
}
