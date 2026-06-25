/**
 * usePassphraseChange — rotate the passphrase that wraps the accountKey.
 * Ported from frontend/settings.js wirePassphraseChange save handler. Requires a
 * fresh reauth proof (updateKeyBackup attaches it); the caller gates the form
 * behind requestSettingsReauth("passphrase") when none is present.
 *
 *   GET key-backup → rewrap(current→new) → PUT (proof) → unwrap(new) → re-session
 *   → persist device session. The accountKey never leaves crypto.ts/session.ts.
 */

import { type ApiError, apiFetch } from "@/lib/api";
import type { ZkKeyBackup } from "@roxabi-live/shared";
import { useMutation } from "@tanstack/react-query";
import {
  type WrappedAccountKey,
  rewrapAccountKeyBackup,
  saveDeviceSession,
  sessionAccountKey,
  unwrapAccountKey,
} from "./crypto";
import { invalidateZkCaches, updateKeyBackup } from "./enroll";
import { getZkReauthProof } from "./github";
import { setZkSession } from "./session";

export interface PassphraseChangeInput {
  current: string;
  newPass: string;
  confirm: string;
}

export function hasReauthProof(): boolean {
  return Boolean(getZkReauthProof());
}

export function usePassphraseChange(login: string) {
  return useMutation<void, Error, PassphraseChangeInput>({
    mutationFn: async ({ current, newPass, confirm }) => {
      if (newPass.length < 8) {
        throw new Error("La nouvelle passphrase doit comporter au moins 8 caractères.");
      }
      if (newPass !== confirm) {
        throw new Error("Les nouvelles passphrases ne correspondent pas.");
      }

      const backup = await apiFetch<ZkKeyBackup>("/api/zk/key-backup");
      const wrapped = await rewrapAccountKeyBackup(current, newPass, backup);
      await updateKeyBackup<unknown>(wrapped as unknown as Record<string, unknown>);

      const accountKey = await unwrapAccountKey(newPass, {
        kdf_params: wrapped.kdf_params,
        wrap_iv: wrapped.wrap_iv,
        wrapped_key: wrapped.wrapped_key,
      } satisfies Pick<WrappedAccountKey, "kdf_params" | "wrap_iv" | "wrapped_key">);
      const session = await sessionAccountKey(accountKey);
      setZkSession(session, wrapped.key_fp);
      await saveDeviceSession(login, accountKey, wrapped.key_fp);
      invalidateZkCaches();
    },
  });
}

/** Map a passphrase-change failure to user copy (wrong current pass / expired proof). */
export function passphraseChangeError(err: Error): string {
  const status = (err as ApiError)?.status;
  if (status === 403) return "Vérification expirée — réessayez le changement de passphrase.";
  if (err.message?.startsWith("La ")) return err.message; // validation messages
  return "Passphrase actuelle incorrecte ou échec de la mise à jour.";
}
