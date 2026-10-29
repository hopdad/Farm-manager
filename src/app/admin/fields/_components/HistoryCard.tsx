'use client';
/**
 * The field panel's History tab on the field's admin page (the same component the panel
 * shows on /board and /m), refreshing the page after an edit.
 */
import { useRouter } from 'next/navigation';
import type { FieldDetail } from '@/domain/fields';
import type { Role } from '@/platform/auth/types';
import { HistoryTab } from '@/ui/fields/tabs/history';

export function HistoryCard({
  fieldId,
  detail,
  role,
}: {
  fieldId: string;
  detail: FieldDetail;
  role: Role;
}) {
  const router = useRouter();
  return (
    <HistoryTab
      fieldId={fieldId}
      detail={detail}
      variant="wall"
      role={role}
      onChanged={() => router.refresh()}
    />
  );
}
