import { ShieldCheckIcon } from "lucide-react";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { AuthState, LanguagePreference } from "../../shared/types";

interface AuthViewProps {
  auth: AuthState;
  accessUnlocked?: boolean;
  onAuthenticated: () => Promise<void>;
  onAuthUpdate: (auth: AuthState) => void;
}

export function AuthView({
  auth,
  accessUnlocked = true,
  onAuthenticated,
  onAuthUpdate,
}: AuthViewProps): React.ReactElement {
  const { languagePref, setLanguagePref, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const languageItems: Array<{ label: string; value: LanguagePreference }> = [
    { label: t("auto"), value: "auto" },
    { label: t("languageEn"), value: "en" },
    { label: t("languageRu"), value: "ru" },
  ];

  function handleLanguageChange(val: string | null) {
    if (val !== "auto" && val !== "en" && val !== "ru") return;
    setLanguagePref(val);
    if (accessUnlocked) {
      void api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ language: val }),
      }).catch(() => {});
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ auth: AuthState }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onAuthUpdate(res.auth);
      if (res.auth.status === "authenticated") {
        await onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("authLoginErrorFallback"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestCode(mfaType: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ auth: AuthState }>("/api/auth/mfa/request", {
        method: "POST",
        body: JSON.stringify({ mfaType }),
      });
      onAuthUpdate(res.auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("authMfaSendErrorFallback"));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({
          code,
          mfaType: auth.status === "mfa_required" ? (auth.sentMfaType ?? 2) : 2,
        }),
      });
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("authMfaVerifyErrorFallback"));
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
                <ShieldCheckIcon aria-hidden="true" className="size-4" />
              </div>
              <CardTitle>{t("appName")}</CardTitle>
            </div>
            <Select
              items={languageItems}
              onValueChange={handleLanguageChange}
              value={languagePref}
            >
              <SelectTrigger aria-label={t("languageLabel")} className="w-28 min-w-0" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {languageItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <CardDescription>
            {auth.status === "mfa_required"
              ? t("authMfaDescription", { email: auth.email })
              : t("authLoginDescription")}
          </CardDescription>
        </CardHeader>

        <CardPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertTitle>{t("authErrorTitle")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {auth.status === "mfa_required" ? (
            <Form className="flex flex-col gap-4" onSubmit={handleVerify}>
              <div className="flex flex-wrap gap-2">
                {(auth.supportedMFATypes ?? [2]).includes(2) && (
                  <Button
                    disabled={busy}
                    onClick={() => void handleRequestCode(2)}
                    size="sm"
                    variant="outline"
                  >
                    {t("authSendEmailCode")}
                  </Button>
                )}
                {(auth.supportedMFATypes ?? []).includes(1) && (
                  <Button
                    disabled={busy}
                    onClick={() => void handleRequestCode(1)}
                    size="sm"
                    variant="outline"
                  >
                    {t("authSendSmsCode")}
                  </Button>
                )}
              </div>

              <Field name="mfaCode">
                <FieldLabel>{t("authMfaCodeLabel")}</FieldLabel>
                <Input
                  autoFocus
                  inputMode="numeric"
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("authMfaCodePlaceholder")}
                  required
                  type="text"
                  value={code}
                />
                <FieldDescription>{t("authMfaCodeHint")}</FieldDescription>
              </Field>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  disabled={busy}
                  onClick={() => onAuthUpdate({ status: "unauthenticated" })}
                  variant="ghost"
                >
                  {t("back")}
                </Button>
                <Button disabled={busy || !code.trim()} loading={busy} type="submit">
                  {t("authConfirmSignIn")}
                </Button>
              </div>
            </Form>
          ) : (
            <Form className="flex flex-col gap-4" onSubmit={handleLogin}>
              <Field name="email">
                <FieldLabel>{t("authEmailLabel")}</FieldLabel>
                <Input
                  autoComplete="email"
                  autoFocus
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("authEmailPlaceholder")}
                  required
                  type="email"
                  value={email}
                />
              </Field>

              <Field name="password">
                <FieldLabel>{t("authPasswordLabel")}</FieldLabel>
                <Input
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  type="password"
                  value={password}
                />
                <FieldDescription>{t("authPasswordHint")}</FieldDescription>
              </Field>

              <Button className="mt-1 w-full" disabled={busy} loading={busy} type="submit">
                {t("authSignInButton")}
              </Button>
            </Form>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
