import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  fetchAgentTemplates,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoaderCircleIcon, PlayIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import type { AgentTemplate } from "@flamecast/protocol/session";

export const Route = createFileRoute("/")({
  component: SessionsPage,
});

function SessionsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["agent-templates"],
    queryFn: fetchAgentTemplates,
  });

  const createMutation = useMutation({
    mutationFn: (agentTemplateId: string) =>
      createSession({ agentTemplateId }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({ to: "/sessions/$id", params: { id: session.id } });
    },
    onError: (err) => {
      toast.error("Failed to create session", {
        description: String(err.message),
      });
    },
  });

  return (
    <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-4">
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Agent templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Select an agent to start a new session.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader className="pb-3">
                  <div className="h-5 w-32 rounded bg-muted" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : templates.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <TerminalIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No agent templates</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Configure agent templates in the server to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template: AgentTemplate) => (
              <Card
                key={template.id}
                className="group transition-colors hover:border-foreground/20"
              >
                <CardHeader className="pb-2 pt-3 px-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                      {template.icon ? (
                        <img src={template.icon} alt={template.name} className="h-4 w-4" />
                      ) : (
                        <TerminalIcon className="h-3 w-3" />
                      )}
                    </div>
                    <CardTitle className="text-xs font-semibold">
                      {template.name}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 px-3 pb-3">
                  <code className="block truncate rounded bg-muted px-1.5 py-1 text-[10px] text-muted-foreground">
                    {template.spawn.command}{" "}
                    {(template.spawn.args ?? []).join(" ")}
                  </code>
                  <Button
                    size="sm"
                    className="w-full h-7 text-xs"
                    onClick={() => createMutation.mutate(template.id)}
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending &&
                    createMutation.variables === template.id ? (
                      <LoaderCircleIcon
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {createMutation.isPending &&
                    createMutation.variables === template.id
                      ? "Starting…"
                      : "Start session"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
