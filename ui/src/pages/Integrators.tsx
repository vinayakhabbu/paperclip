import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Plug,
  Server,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CompanyIntegrator, WorkflowConnector } from "@paperclipai/shared";
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

const ICONS: Record<string, LucideIcon> = {
  Server,
  Users,
  DollarSign,
  ShoppingCart,
  Boxes,
  CalendarClock,
  ClipboardList,
};

const ACCENT: Record<WorkflowConnector, string> = {
  core: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  it: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
  hr: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
  finance: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  procurement: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  sap: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
  workday: "bg-orange-500/10 text-orange-600 dark:text-orange-300",
  jira: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
};

export function Integrators() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Integrators" }]);
  }, [setBreadcrumbs]);

  const integratorsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.integrators(selectedCompanyId!),
    queryFn: () => agentsStudioApi.listIntegrators(selectedCompanyId!).then((r) => r.integrators),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.integrators(selectedCompanyId!) });

  const connectMutation = useMutation({
    mutationFn: (vars: { key: string; config: Record<string, unknown> }) =>
      agentsStudioApi.connectIntegrator(selectedCompanyId!, vars.key, vars.config),
    onSuccess: (res) => {
      pushToast({ title: `Connected ${res.integrator.system}`, tone: "success" });
      setOpenKey(null);
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Connect failed", body: e.message, tone: "error" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (key: string) => agentsStudioApi.disconnectIntegrator(selectedCompanyId!, key),
    onSuccess: (res) => {
      pushToast({ title: `Disconnected ${res.integrator.system}`, tone: "success" });
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Disconnect failed", body: e.message, tone: "error" }),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Plug} message="Select a company to manage integrators." />;
  }

  const integrators = integratorsQuery.data ?? [];
  const connectedCount = integrators.filter((i) => i.status === "connected").length;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Integrators</h1>
          <Badge variant="outline" className="ml-1">
            {connectedCount}/{integrators.length} connected
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect the enterprise systems your AI factory stitches into workflows. Each integrator exposes typed
          actions that workflow steps call in Agents Studio.
        </p>
      </header>

      {integratorsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {integrators.map((it) => (
            <IntegratorCard
              key={it.key}
              integrator={it}
              open={openKey === it.key}
              onToggle={() => setOpenKey((cur) => (cur === it.key ? null : it.key))}
              onConnect={(config) => connectMutation.mutate({ key: it.key, config })}
              onDisconnect={() => disconnectMutation.mutate(it.key)}
              busy={connectMutation.isPending || disconnectMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegratorCard({
  integrator,
  open,
  onToggle,
  onConnect,
  onDisconnect,
  busy,
}: {
  integrator: CompanyIntegrator;
  open: boolean;
  onToggle: () => void;
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const Icon = ICONS[integrator.icon] ?? Plug;
  const connected = integrator.status === "connected";
  const [form, setForm] = useState<Record<string, string>>({});

  return (
    <div className="flex flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-start gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-md ${ACCENT[integrator.key] ?? ACCENT.core}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{integrator.system}</span>
            {connected ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Available</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{integrator.label}</p>
        </div>
      </div>
      <p className="mb-3 flex-1 text-xs text-muted-foreground">
        {integrator.description} · {integrator.actionCount} actions · auth: {integrator.authType}
      </p>

      {connected ? (
        <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      ) : open ? (
        <div className="space-y-2">
          {integrator.authFields.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">{field.label}</label>
              <Input
                type={/token|secret|key|password/i.test(field.key) ? "password" : "text"}
                placeholder={field.placeholder}
                value={form[field.key] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="flex gap-1.5 pt-1">
            <Button size="sm" className="flex-1" disabled={busy} onClick={() => onConnect(form)}>
              Connect
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggle}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="w-full" onClick={onToggle}>
          <Plug className="mr-1.5 h-3.5 w-3.5" />
          Connect
        </Button>
      )}
    </div>
  );
}
