import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ModeToggle } from "@/components/mode-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "./AuthContext";

const DEMO_ACCOUNTS = [
  {
    role: "admin" as const,
    label: "Admin",
    tagline: "Admin — network-wide (all 15 branches, full executive & financial BD KPIs)",
    email: "admin@stockflow.dev",
    pass: "Admin@12345",
  },
  {
    role: "manager" as const,
    label: "Manager",
    tagline: "Manager — Manama cluster (BR-001 & BR-002: Manama - CBD & Juffair, scoped BD + pending backlog)",
    email: "manager.manama@stockflow.dev",
    pass: "Manager@12345",
  },
  {
    role: "staff" as const,
    label: "Staff",
    tagline: "Staff — Manama - CBD store (BR-001 shelf stock & cover days, no financial BD)",
    email: "staff.manama@stockflow.dev",
    pass: "Staff@12345",
  },
];

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from =
    (location.state as { from?: { pathname?: string } })?.from?.pathname || "/queue";
  const showDemoAccounts = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS !== "false";

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="fixed top-4 right-4">
        <ModeToggle />
      </div>

      <Card className="w-full max-w-md rounded-2xl border border-border bg-card shadow-card">
        <CardHeader className="items-center text-center">
          <div className="brand-gradient mb-2 flex size-10 items-center justify-center rounded-xl text-sm font-bold text-white shadow-xs">
            SF
          </div>
          <CardTitle className="text-xl font-semibold tracking-tight text-foreground">
            Sign in to StockFlow
          </CardTitle>
          <CardDescription>
            Enter your role-assigned credentials to access the inventory action queue
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error ? (
              <div
                role="alert"
                className="rounded-xl border border-risk-ring bg-risk-bg px-3.5 py-2.5 text-xs font-medium text-risk-text"
              >
                {error}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="email"
              >
                Email address
              </label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="buyer@stockflow.dev"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="password"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="hero-cta-glow pt-1">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={isSubmitting}
                className="w-full font-semibold"
              >
                Sign in
              </Button>
            </div>
          </form>

          {showDemoAccounts ? (
            <details className="mt-6 rounded-xl border border-border bg-secondary/40 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-foreground select-none">
                Demo accounts (click to expand)
              </summary>
              <div className="mt-3 space-y-2">
                {DEMO_ACCOUNTS.map((acct) => (
                  <div
                    key={acct.email}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={acct.role} className="px-2 py-0 text-[10px]">
                          {acct.role}
                        </Badge>
                        <span className="truncate font-semibold text-foreground">
                          {acct.label}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] font-medium text-foreground/80">
                        {acct.tagline}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {acct.email} · {acct.pass}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        setEmail(acct.email);
                        setPassword(acct.pass);
                        setError(null);
                      }}
                    >
                      Use
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
