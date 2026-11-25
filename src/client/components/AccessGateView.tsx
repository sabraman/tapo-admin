import { LockIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { LanguagePreference } from "../../shared/types";

interface AccessGateViewProps {
  onUnlocked: () => Promise<void>;
}

export function AccessGateView({ onUnlocked }: AccessGateViewProps): React.ReactElement {
  const { languagePref, setLanguagePref, t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<{ ok?: boolean }>("/api/access/unlock", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      if (languagePref !== "auto") {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ language: languagePref }),
        }).catch(() => {});
      }
      await onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accessGateErrorFallback"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <LockIcon aria-hidden="true" className="size-4" />
              </div>
              <CardTitle>{t("appName")}</CardTitle>
            </div>

            <SegmentedControl
              aria-label={t("languageLabel")}
              render={
                <RadioGroupPrimitive
                  onValueChange={(v) => setLanguagePref(String(v) as LanguagePreference)}
                  value={languagePref}
                />
              }
              size="sm"
            >
              <SegmentedControlItem render={<RadioPrimitive.Root value="auto" />}>
                {t("auto")}
              </SegmentedControlItem>
              <SegmentedControlItem render={<RadioPrimitive.Root value="en" />}>
                EN
              </SegmentedControlItem>
              <SegmentedControlItem render={<RadioPrimitive.Root value="ru" />}>
                RU
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
          <CardDescription>{t("accessGateDescription")}</CardDescription>
        </CardHeader>

        <CardPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertTitle>{t("accessGateErrorTitle")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Form className="flex flex-col gap-4" onSubmit={handleUnlock}>
            <Field name="accessPassword">
              <FieldLabel>{t("accessGatePasswordLabel")}</FieldLabel>
              <Input
                autoComplete="current-password"
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("accessGatePasswordPlaceholder")}
                required
                type="password"
                value={password}
              />
              <FieldDescription>{t("accessGatePasswordHint")}</FieldDescription>
            </Field>

            <Button className="mt-1 w-full" disabled={busy || !password} loading={busy} type="submit">
              {t("accessGateSubmit")}
            </Button>
          </Form>
        </CardPanel>
      </Card>
    </div>
  );
}
