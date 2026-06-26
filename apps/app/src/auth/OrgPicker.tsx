/**
 * OrgPicker — switch active installation when the user belongs to more than one.
 * Ported from frontend/auth.js renderOrgPicker. Hidden for single-tenant users.
 */

import { useActiveTenant } from "@/auth/useAuthMutations";
import { SingleSelect } from "@/components/SingleSelect";
import { useT } from "@/i18n";
import type { MePayload } from "@roxabi-live/shared";

export function OrgPicker({ me }: { me: MePayload }) {
  const switchTenant = useActiveTenant();
  const t = useT();
  if (me.installations.length <= 1) return null;

  return (
    <SingleSelect
      ariaLabel={t("auth.orgPicker.ariaLabel")}
      value={String(me.active_tenant_id ?? "")}
      options={me.installations.map((inst) => ({
        value: String(inst.tenant_id),
        label: inst.account_login,
      }))}
      onChange={(v) => switchTenant.mutate(Number(v))}
      triggerClassName="h-9"
    />
  );
}
