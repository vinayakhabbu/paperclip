import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";
import { CircleDot } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { MarkdownBody } from "./MarkdownBody";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { relativeTime } from "../lib/utils";

// One chronological feed of everything the agents did across a task and all
// of its subtasks: task creations + every comment, in sequence, each entry
// chipped with the subtask it happened on. Built entirely from existing APIs
// (issues?descendantOf= + per-issue comments) — no server changes.
// ponytail: fetches full comment history per issue in the tree; add paging if
// incident trees ever exceed a few hundred comments.

type TimelineEntry = {
  at: number;
  issue: Issue;
  kind: "created" | "comment";
  comment?: IssueComment;
};

export function IssueSubtreeTimeline({
  issueId,
  companyId,
  agentMap,
  userLabelMap,
}: {
  issueId: string;
  companyId: string;
  agentMap: Map<string, Agent>;
  userLabelMap?: Map<string, string>;
}) {
  const { data: treeIssues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.listByDescendantRoot(companyId, issueId),
    queryFn: () => issuesApi.list(companyId, { descendantOf: issueId }),
  });

  const sortedIssues = useMemo(
    () => [...(treeIssues ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    ),
    [treeIssues],
  );

  const commentQueries = useQueries({
    queries: sortedIssues.map((issue) => ({
      queryKey: ["issue-subtree-timeline-comments", issue.id],
      queryFn: () => issuesApi.listComments(issue.id, { order: "asc" as const }),
    })),
  });
  const commentsLoading = commentQueries.some((query) => query.isLoading);

  const entries = useMemo(() => {
    const out: TimelineEntry[] = sortedIssues.map((issue) => ({
      at: new Date(issue.createdAt).getTime(),
      issue,
      kind: "created" as const,
    }));
    sortedIssues.forEach((issue, index) => {
      for (const comment of commentQueries[index]?.data ?? []) {
        if (comment.deletedAt) continue;
        out.push({ at: new Date(comment.createdAt).getTime(), issue, kind: "comment", comment });
      }
    });
    return out.sort((a, b) => a.at - b.at);
  }, [sortedIssues, commentQueries]);

  function authorLabel(comment: IssueComment): string {
    const agentId = comment.authorAgentId ?? comment.derivedAuthorAgentId;
    if (agentId) return agentMap.get(agentId)?.name ?? "Agent";
    if (comment.authorUserId) return userLabelMap?.get(comment.authorUserId) ?? "Board";
    return "System";
  }

  if (issuesLoading || commentsLoading) return <PageSkeleton variant="list" />;
  if (entries.length === 0) {
    return <EmptyState icon={CircleDot} message="No activity in this task tree yet." />;
  }

  return (
    <div className="space-y-4">
      {entries.map((entry) => {
        const pathId = entry.issue.identifier ?? entry.issue.id;
        const chip = (
          <Link
            to={createIssueDetailPath(pathId)}
            className="shrink-0 rounded bg-accent/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground no-underline hover:text-foreground"
          >
            {entry.issue.identifier ?? entry.issue.id.slice(0, 8)}
          </Link>
        );
        const timestamp = (
          <span
            className="ml-auto shrink-0 text-[11px] text-muted-foreground/70"
            title={new Date(entry.at).toLocaleString()}
          >
            {relativeTime(new Date(entry.at))}
          </span>
        );
        if (entry.kind === "created") {
          return (
            <div key={`created-${entry.issue.id}`} className="flex items-center gap-2 text-xs text-muted-foreground">
              {chip}
              <span className="min-w-0 truncate">
                Task created: <span className="text-foreground/80">{entry.issue.title}</span>
              </span>
              {timestamp}
            </div>
          );
        }
        const comment = entry.comment!;
        return (
          <div key={comment.id} className="rounded-md border border-border bg-card p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{authorLabel(comment)}</span>
              {chip}
              {timestamp}
            </div>
            <MarkdownBody className="text-sm" linkIssueReferences>
              {comment.body}
            </MarkdownBody>
          </div>
        );
      })}
    </div>
  );
}
