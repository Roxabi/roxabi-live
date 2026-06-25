/**
 * OrgPicker — switch active installation when the user belongs to more than one.
 * Ported from frontend/auth.js renderOrgPicker. Hidden for single-tenant users.
 */

import { useActiveTenant } from "@/auth/useAuthMutations";
import { cn } from "@/lib/utils";
import type { MePayload } from "@roxabi-live/shared";

export function OrgPicker({ me }: { me: MePayload }) {
  const switchTenant = useActiveTenant();
  if (me.installations.length <= 1) return null;

  return (
    <select
      aria-label="Active installation"
      value={me.active_tenant_id ?? ""}
      disabled={switchTenant.isPending}
      onChange={(e) => switchTenant.mutate(Number(e.target.value))}
      className={cn(
        "h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
      )}
    >
      {me.installations.map((inst) => (
        <option key={inst.tenant_id} value={inst.tenant_id}>
          {inst.account_login}
        </option>
      ))}
    </select>
  );
}
