import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as { from?: { pathname?: string } })?.from?.pathname || "/";

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
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md shadow-card">
        <CardHeader className="text-center">
          <CardTitle className="brand-gradient bg-clip-text text-2xl font-bold tracking-tight text-transparent">
            StockFlow
          </CardTitle>
          <CardDescription>Sign in with your role-assigned credentials</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="email">
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
              <label className="text-xs font-medium text-muted-foreground" htmlFor="password">
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

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              Sign In
            </Button>
          </form>

          <div className="mt-6 rounded-lg border bg-[var(--lavender-50)]/50 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">Demo Accounts:</p>
            <div className="mt-1.5 space-y-1 font-mono text-[11px]">
              <p>
                <span className="font-bold">admin:</span> admin@stockflow.dev / Admin@12345
              </p>
              <p>
                <span className="font-bold">manager:</span> manager.midwest@stockflow.dev / Manager@12345
              </p>
              <p>
                <span className="font-bold">staff:</span> staff.chicago@stockflow.dev / Staff@12345
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
