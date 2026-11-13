import { useQuery } from "@tanstack/react-query";
import { ErrorBlock, EmptyBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { REASON_LABELS, actionLabel, formatDateTime, formatMoneyFull, statusLabel } from "@/lib/format";

export function AuditPage() {
  const audit = useQuery({ queryKey: queryKeys.audit, queryFn: api.audit });

  if (audit.isPending) return <LoadingBlock />;
  if (audit.isError) return <ErrorBlock message={audit.error.message} onRetry={() => void audit.refetch()} />;
  if (audit.data.entries.length === 0) {
    return <EmptyBlock title="No decisions yet" body="Approve or reject an action and it will show up here." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">Every approve and reject, newest first.</p>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-[var(--lavender-50)] text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Decision</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Branch</th>
              <th className="px-3 py-2 text-right font-medium">Net benefit</th>
              <th className="px-3 py-2 font-medium">Reason codes</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id} className="border-t align-top">
                <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(entry.at)}</td>
                <td className="px-3 py-2">
                  <div>{entry.user}</div>
                  {entry.actedBy ? (
                    <div className="text-xs text-muted-foreground capitalize">
                      {entry.actedBy.role}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={entry.decision === "APPROVED" ? "approved" : "rejected"}>
                    {statusLabel(entry.decision)}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge
                    tone={
                      entry.action === "TRANSFER" ? "transfer" : entry.action === "REORDER" ? "reorder" : "markdown"
                    }
                  >
                    {actionLabel(entry.action)}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div>{entry.productName}</div>
                  <div className="text-xs text-muted-foreground">{entry.sku}</div>
                </td>
                <td className="px-3 py-2">
                  <div>{entry.branchName}</div>
                  <div className="text-xs text-muted-foreground">{entry.branchId}</div>
                </td>
                <td className="px-3 py-2 text-right">{formatMoneyFull(entry.netBenefit)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {entry.reasonCodes.map((code) => (
                      <span key={code} className="rounded-full bg-[var(--lavender-50)] px-2 py-0.5 text-xs" title={REASON_LABELS[code]}>
                        {code}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
