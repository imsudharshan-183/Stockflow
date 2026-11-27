import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useBahrainToday } from "@/hooks/useBahrainToday";
import { invalidateOperationalQueries } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";

export function DailySalesSimulation({ nextDatasetDay = false }: { nextDatasetDay?: boolean }) {
  const client = useQueryClient();
  const today = useBahrainToday().isoDate;
  const capability = useQuery({ queryKey: ["health"], queryFn: api.health });
  const enabled = capability.data?.allowSyntheticData === true;
  const statusKey = ["salesSimulation", today] as const;
  const status = useQuery({ queryKey: statusKey, queryFn: api.simulationStatus, enabled });
  const generate = useMutation({
    mutationFn: nextDatasetDay ? api.simulateNextDay : api.simulateToday,
    onSuccess: async result => {
      client.setQueryData(statusKey, { day: status.data?.day ?? today, result });
      await invalidateOperationalQueries(client);
    },
    onError: () => client.invalidateQueries({ queryKey: statusKey }),
  });
  if (!enabled) return null;
  const result = status.data?.result;
  const label = nextDatasetDay ? "Simulate next dataset day" : "Generate today's sales";
  return (
    <section aria-label="Demo tools" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Sample sales</h2>
        <p className="text-sm text-muted-foreground">
          {nextDatasetDay ? "Advance the dataset by one day." : "Fill missing sales for today across active branches."}
          {" "}One simulation per Bahrain day. Store teams can enter or correct sales at any time.
        </p>
        <p role="status" className="text-sm">
          {result ? `Daily run complete. Added ${formatNumber(result.rows)} sales rows across ${formatNumber(result.branches)} branches for ${formatDate(result.targetDate)}.` : generate.error?.message ?? status.error?.message}
        </p>
      </div>
      <Button variant="secondary" size="sm" disabled={!status.data || Boolean(result) || generate.isPending} onClick={() => generate.mutate()}>
        {generate.isPending ? "Generating sales…" : label}
      </Button>
    </section>
  );
}
