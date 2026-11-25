import React from 'react';
import type { TickInfo } from '@/lib/api/types';
import { roleEditIntro, roleEditSummary } from '../lib/editWords';
import type { RoleEdit } from '../lib/roleEdit';
import { SensitiveTag } from './TickGroup';

// What is about to be saved, for the password step of the Edit role screen (plan: access and roles, Task 25; the picture is mockups/4-password-confirm.png): who has the role, then a box with
// "Turning on" (the ticks, the sensitive ones marked), "Turning off" ("Nothing" when no tick goes), the new name and a changed description. The words are `roleEditSummary`'s; ticks are
// told by their words, the role by its name.

export default function RoleEditSummary({
  edit,
  catalogue,
}: {
  edit: RoleEdit;
  catalogue: readonly TickInfo[];
}) {
  const parts = roleEditSummary(edit, catalogue);
  return (
    <>
      <p className="text-muted-foreground">{roleEditIntro(edit)}</p>
      <div
        data-testid="edit-role-summary"
        className="overflow-hidden rounded-lg border border-border"
      >
        {parts.map((part, place) => (
          <div key={place} className="border-t border-border px-3 py-2.5 first:border-t-0">
            {part.kind === 'ticks' ? (
              <>
                <b
                  className={`mb-0.5 block text-xs font-bold uppercase tracking-wider ${
                    part.heading === 'Turning on' ? 'text-green-600' : 'text-muted-foreground'
                  }`}
                >
                  {part.heading}
                </b>
                {part.ticks.length === 0 ? (
                  <span className="text-muted-foreground">Nothing</span>
                ) : (
                  <ul className="list-disc space-y-0.5 pl-[18px]">
                    {part.ticks.map((tick) => (
                      <li key={tick.label}>
                        {tick.label}
                        {tick.sensitive && <SensitiveTag />}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p>{part.text}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
