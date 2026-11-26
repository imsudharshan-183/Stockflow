import { useMutation } from "@tanstack/react-query";
import type { BriefRequest } from "@stockflow/core";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthContext";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

export function StockBrief(props: BriefRequest) {
  const { user } = useAuth();
  if (!user) return null;
  const scope = "orderId" in props ? props.orderId : props.branchId;
  return (
    <BriefPanel key={JSON.stringify([user.id, user.role, user.branchIds, scope])} {...props} />
  );
}

function BriefPanel(props: BriefRequest) {
  const { data, error, isPending, mutate } = useMutation({ mutationFn: api.brief });
  const transfer = "orderId" in props;
  const title = transfer ? "Transfer explanation" : "Morning brief";
  return (
    <section
      aria-label={title}
      className="space-y-2 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button size="sm" variant="secondary" loading={isPending} onClick={() => mutate(props)}>
          {data ? "Refresh brief" : transfer ? "Explain this transfer" : "Show my brief"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-risk-text">
          {error.message}
        </p>
      )}
      {data && (
        <div aria-live="polite" className="space-y-2 text-sm">
          <p>{data.summary}</p>
          <ul className="divide-y divide-border">
            {data.facts.map((fact) => (
              <li key={fact.id} className="flex flex-wrap justify-between gap-x-3 py-1">
                {fact.href?.startsWith("#") ? (
                  <a href={fact.href} className="text-primary hover:underline">
                    {fact.label}
                  </a>
                ) : fact.href ? (
                  <Link className="text-primary hover:underline" to={fact.href}>
                    {fact.label}
                  </Link>
                ) : (
                  <span>{fact.label}</span>
                )}
                <span className="font-medium tabular-nums">{fact.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {data.source !== "records" ? "AI-assisted record review" : "Record summary"} ·{" "}
            {transfer ? "Order updated" : "Stock data through"} {formatDate(data.asOf)}
          </p>
        </div>
      )}
    </section>
  );
}
