/** Shared non-dismissable modal shell for the ZK gate dialogs (enroll/unlock/reset). */

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function ZkGateDialog({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open>
      <DialogContent showClose={false} className="max-w-md" data-testid={testId}>
        <DialogTitle className="text-xl font-semibold text-foreground">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Inline error line shared by the gate forms. */
export function ZkFormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-blocked" role="alert" data-testid="zk-form-error">
      {message}
    </p>
  );
}
