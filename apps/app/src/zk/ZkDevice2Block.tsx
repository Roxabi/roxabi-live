/**
 * ZkDevice2Block — permanent block shown when this browser has no local ECDH key
 * yet the account already has v1 ciphertext sealed elsewhere (Device 2 before the
 * passphrase backup existed). Ported from frontend/zk-enroll.js renderDevice2Block.
 * Enrollment cannot proceed here until setup completes on the original device.
 */

import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { ZkGateDialog } from "./ZkDialogShell";
import { zkLoginUrl } from "./github";

export function ZkDevice2Block() {
  const t = useT();
  const logout = useLogout();
  return (
    <ZkGateDialog
      title={t("zk.device2.title")}
      testId="zk-device2-block"
    >
      <p className="text-sm text-muted-foreground">
        {t("zk.device2.body1")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("zk.device2.body2Prefix")}{" "}
        <a
          href={zkLoginUrl()}
          className="text-primary underline-offset-4 hover:underline"
          data-testid="zk-device2-link"
        >
          {t("zk.device2.linkGithub")}
        </a>{" "}
        {t("zk.device2.body2Suffix")}
      </p>
      <div className="flex items-center justify-between gap-3 pt-1">
        <Button type="button" variant="ghost" onClick={() => logout.mutate(undefined)}>
          {t("zk.common.logout")}
        </Button>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
          {t("zk.device2.reload")}
        </Button>
      </div>
    </ZkGateDialog>
  );
}
