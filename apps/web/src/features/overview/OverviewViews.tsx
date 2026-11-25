import { ArrowRight, ChartNoAxesColumn, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, formatNumber } from "@/lib/format";

export function OverviewViews({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "reports" ? "reports" : "daily";
  return (
    <Tabs value={view} onValueChange={(next) => {
      const updated = new URLSearchParams(params);
      if (next === "reports") updated.set("view", "reports");
      else updated.delete("view");
      setParams(updated, { preventScrollReset: true });
    }} className="gap-5">
      <TabsList aria-label="Overview views" className="max-w-full border border-border bg-secondary">
        <TabsTrigger value="daily"><ListChecks aria-hidden="true" />Daily work</TabsTrigger>
        <TabsTrigger value="reports"><ChartNoAxesColumn aria-hidden="true" />Reports and trends</TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  );
}

export function QueueSummary({ count, gain }: { count: number; gain: number }) {
  return (
    <section className="hero-surface flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border px-5 py-5 sm:px-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {count > 0 ? `${formatNumber(count)} ${count === 1 ? "action needs" : "actions need"} review` : "All actions reviewed"}
        </h2>
        {count > 0 && <p className="mt-1 text-sm text-muted-foreground">{formatMoney(gain)} estimated gain across pending actions</p>}
      </div>
      <Link to="/queue" className={buttonVariants({ variant: "primary" })}>
        {count > 0 ? "Review actions" : "Open action queue"}<ArrowRight aria-hidden="true" />
      </Link>
    </section>
  );
}
