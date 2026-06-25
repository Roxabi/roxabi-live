/**
 * ZkDevice2Block — permanent block shown when this browser has no local ECDH key
 * yet the account already has v1 ciphertext sealed elsewhere (Device 2 before the
 * passphrase backup existed). Ported from frontend/zk-enroll.js renderDevice2Block.
 * Enrollment cannot proceed here until setup completes on the original device.
 */

import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { ZkGateDialog } from "./ZkDialogShell";
import { zkLoginUrl } from "./github";

export function ZkDevice2Block() {
  const logout = useLogout();
  return (
    <ZkGateDialog
      title="Terminez la configuration sur votre appareil d'origine"
      testId="zk-device2-block"
    >
      <p className="text-sm text-muted-foreground">
        Des titres d'issues chiffrés sur ce compte ont été scellés dans un autre navigateur avant la
        configuration de la sauvegarde par passphrase. Cet appareil ne peut pas les déchiffrer ni
        terminer l'enrôlement tant que vous n'ouvrez pas Roxabi sur votre{" "}
        <strong>appareil d'origine</strong> pour y finaliser le chiffrement.
      </p>
      <p className="text-sm text-muted-foreground">
        Une fois la configuration faite sur l'appareil d'origine, vous pouvez aussi{" "}
        <a
          href={zkLoginUrl()}
          className="text-primary underline-offset-4 hover:underline"
          data-testid="zk-device2-link"
        >
          lier GitHub
        </a>{" "}
        ici pour re-sceller le contenu depuis GitHub.
      </p>
      <div className="flex items-center justify-between gap-3 pt-1">
        <Button type="button" variant="ghost" onClick={() => logout.mutate(undefined)}>
          Se déconnecter
        </Button>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
          Recharger
        </Button>
      </div>
    </ZkGateDialog>
  );
}
