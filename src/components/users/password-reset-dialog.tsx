import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Mail } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { passwordResetContent } from "@/content/users";
import {
  resetUserPassword,
  sendPasswordResetEmail,
  signOutCurrentSession,
} from "@/lib/password-reset";
import type { Profile } from "@/lib/types";

interface PasswordResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile | null;
  isSelf?: boolean;
  onDone?: () => void;
}

export function PasswordResetDialog({
  open,
  onOpenChange,
  profile,
  isSelf = false,
  onDone,
}: PasswordResetDialogProps) {
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setTempPassword(null);
      setEmailConfigured(false);
      setSendingEmail(false);
      setEmailSent(false);
      setCopied(false);
    }
  }, [open, profile?.id]);

  async function handleOpenChange(nextOpen: boolean) {
    if (busy) return;
    const shouldSignOut = !nextOpen && Boolean(isSelf && tempPassword);
    onOpenChange(nextOpen);
    if (shouldSignOut) {
      await signOutCurrentSession();
      window.location.assign("/login");
    }
  }

  async function handleConfirmReset() {
    if (!profile || busy) return;
    setBusy(true);
    const result = await resetUserPassword(profile.id);
    setBusy(false);

    if (!result.ok || !result.password) {
      toast.error(`${passwordResetContent.errorPrefix}: ${result.message}`);
      return;
    }

    setTempPassword(result.password);
    setEmailConfigured(Boolean(result.emailConfigured));
    toast.success(passwordResetContent.successTitle);
    onDone?.();
  }

  async function handleCopy() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      toast.success(passwordResetContent.copied);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(passwordResetContent.copyFailed);
    }
  }

  async function handleSendEmail() {
    if (!profile || !tempPassword || sendingEmail) return;
    setSendingEmail(true);
    const result = await sendPasswordResetEmail(profile.id, tempPassword);
    setSendingEmail(false);

    if (result.ok) {
      setEmailSent(true);
      toast.success(passwordResetContent.emailSent);
    } else {
      toast.error(result.message);
    }
  }

  const displayName = profile?.full_name || profile?.email || "";

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={tempPassword ? passwordResetContent.successTitle : passwordResetContent.title}
      description={
        profile ? passwordResetContent.description(displayName, profile.email) : undefined
      }
      size="sm"
    >
      {!tempPassword ? (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {passwordResetContent.explanation}
          </p>
          {profile?.email ? (
            <p className="text-xs text-muted-foreground">
              {passwordResetContent.recipientLabel}{" "}
              <span className="font-medium text-foreground" dir="ltr">
                {profile.email}
              </span>
            </p>
          ) : null}
          {isSelf ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {passwordResetContent.selfWarning}
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {passwordResetContent.cancel}
            </Button>
            <Button type="button" onClick={handleConfirmReset} disabled={busy || !profile}>
              <KeyRound className="size-4" />
              {busy ? passwordResetContent.resetting : passwordResetContent.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {passwordResetContent.successHint}
            </p>
            <div
              dir="ltr"
              className="select-all rounded-lg border border-border bg-muted/50 px-4 py-3 text-center font-mono text-lg font-bold tracking-wider text-foreground"
            >
              {tempPassword}
            </div>
          </div>
          <p className="text-xs leading-relaxed text-amber-700">
            {passwordResetContent.notShownAgain}
          </p>
          {!emailConfigured ? (
            <p className="text-xs text-muted-foreground">
              {passwordResetContent.emailNotConfigured}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {passwordResetContent.copy}
              </Button>
              {emailConfigured && profile?.email ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSendEmail}
                  disabled={sendingEmail || emailSent}
                >
                  <Mail className="size-4" />
                  {sendingEmail
                    ? passwordResetContent.sendingEmail
                    : passwordResetContent.sendEmail}
                </Button>
              ) : null}
            </div>
            <Button type="button" onClick={() => handleOpenChange(false)}>
              {passwordResetContent.close}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
