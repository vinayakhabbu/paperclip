import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Factory as FactoryIcon, Plus, Trash2 } from "lucide-react";
import {
  FACTORY_STAGES,
  FACTORY_STAGE_LABELS,
  AGENT_DOMAINS,
  type AgentDomain,
  type FactoryOrder,
  type FactoryStage,
} from "@paperclipai/shared";
import { agentsStudioApi } from "../api/agentsStudio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring";

export function Factory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [domain, setDomain] = useState<AgentDomain>("it");

  useEffect(() => {
    setBreadcrumbs([{ label: "AI Factory" }]);
  }, [setBreadcrumbs]);

  const ordersQuery = useQuery({
    queryKey: queryKeys.agentsStudio.orders(selectedCompanyId!),
    queryFn: () => agentsStudioApi.listOrders(selectedCompanyId!).then((r) => r.orders),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.orders(selectedCompanyId!) });

  const createMutation = useMutation({
    mutationFn: () => agentsStudioApi.createOrder(selectedCompanyId!, { title: title.trim(), domain }),
    onSuccess: () => {
      pushToast({ title: "Factory order created", tone: "success" });
      setTitle("");
      setShowNew(false);
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Create failed", body: e.message, tone: "error" }),
  });

  const advanceMutation = useMutation({
    mutationFn: (id: string) => agentsStudioApi.advanceOrder(selectedCompanyId!, id),
    onSuccess: (res) => {
      pushToast({ title: `Promoted to ${FACTORY_STAGE_LABELS[res.order.stage]}`, tone: "success" });
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Promote failed", body: e.message, tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => agentsStudioApi.deleteOrder(selectedCompanyId!, id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => pushToast({ title: "Delete failed", body: e.message, tone: "error" }),
  });

  const byStage = useMemo(() => {
    const map: Record<FactoryStage, FactoryOrder[]> = {
      intake: [],
      design: [],
      build: [],
      test: [],
      deploy: [],
      live: [],
    };
    for (const o of ordersQuery.data ?? []) map[o.stage as FactoryStage]?.push(o);
    return map;
  }, [ordersQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FactoryIcon} message="Select a company to open the AI Factory." />;
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FactoryIcon className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">AI SDLC Factory</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Each order moves through the lifecycle — intake, design, build, test, deploy — and ships a new agent
            and workflow built in Agents Studio.
          </p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => setShowNew((v) => !v)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New order
        </Button>
      </header>

      {showNew && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3 shadow-sm">
          <div className="min-w-[220px] flex-1">
            <label className="text-[11px] font-medium text-muted-foreground">Title</label>
            <Input placeholder="e.g. Automate expense approvals" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="w-32">
            <label className="text-[11px] font-medium text-muted-foreground">Domain</label>
            <select className={selectCls} value={domain} onChange={(e) => setDomain(e.target.value as AgentDomain)}>
              {AGENT_DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <Button size="sm" disabled={!title.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
            Create order
          </Button>
        </div>
      )}

      {ordersQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : (ordersQuery.data ?? []).length === 0 ? (
        <EmptyState icon={FactoryIcon} message="No factory orders yet. Create one to start the pipeline." />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {FACTORY_STAGES.map((stage) => (
            <div key={stage} className="rounded-lg border bg-muted/20 p-2">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-semibold">{FACTORY_STAGE_LABELS[stage]}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {byStage[stage].length}
                </Badge>
              </div>
              <div className="space-y-2">
                {byStage[stage].map((order) => (
                  <div key={order.id} className="rounded-md border bg-card p-2 shadow-sm">
                    <p className="text-xs font-medium leading-snug">{order.title}</p>
                    <Badge variant="outline" className="mt-1 text-[10px]">
                      {order.domain.toUpperCase()}
                    </Badge>
                    <div className="mt-2 flex items-center gap-1">
                      {stage !== "live" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={advanceMutation.isPending}
                          onClick={() => advanceMutation.mutate(order.id)}
                        >
                          Promote <ArrowRight className="ml-0.5 h-3 w-3" />
                        </Button>
                      )}
                      <button
                        type="button"
                        className="ml-auto"
                        aria-label="Delete order"
                        onClick={() => deleteMutation.mutate(order.id)}
                      >
                        <Trash2 className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
