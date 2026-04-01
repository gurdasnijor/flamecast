import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { Trash2Icon } from "lucide-react";

export function SessionsSidebar() {
  const activeSessionId = useRouterState({
    select: (s) => s.matches.find((m) => m.routeId === "/sessions/$id")?.params.id,
  });

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 30_000,
  });

  // Sort by most recent first
  const sorted = sessions
    ? [...(sessions as Array<Record<string, any>>)].sort((a, b) => {
        const ta = String(a.startedAt ?? a.lastUpdatedAt ?? "");
        const tb = String(b.startedAt ?? b.lastUpdatedAt ?? "");
        return tb.localeCompare(ta);
      })
    : undefined;

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <span className="text-base leading-none">🔥</span>
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Flamecast</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <>
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                </>
              ) : !sorted?.length ? (
                <p className="px-2 text-xs text-sidebar-foreground/70">
                  No sessions. Open the home page to create one.
                </p>
              ) : (
                sorted.map((session: Record<string, any>) => {
                  const agentName =
                    session.agent?.name ?? session.agentName ?? "Agent";
                  const status = session.status ?? "active";
                  const protocol = session.protocol ?? "";
                  const startedAt = session.startedAt
                    ? new Date(session.startedAt).toLocaleTimeString()
                    : "";

                  return (
                    <SidebarMenuItem key={session.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={session.id === activeSessionId}
                        tooltip={`${agentName} · ${session.id.slice(-8)}`}
                        className="!h-auto min-h-8 items-start py-2 pr-10"
                      >
                        <Link to="/sessions/$id" params={{ id: session.id }}>
                          <span className="grid min-w-0 flex-1 gap-0.5 leading-snug">
                            <span className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  status === "active" || status === "running"
                                    ? "bg-green-500"
                                    : status === "killed"
                                      ? "bg-red-400"
                                      : "bg-muted-foreground/50",
                                )}
                              />
                              <span className="truncate text-sm font-medium">
                                {agentName}
                              </span>
                            </span>
                            <span className="truncate text-[11px] text-sidebar-foreground/55">
                              {protocol ? `${protocol} · ` : ""}
                              {startedAt}
                              {" · "}
                              {session.id.slice(-6)}
                            </span>
                          </span>
                        </Link>
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        showOnHover
                        title="Terminate session"
                        className={cn(
                          "z-10 !top-1/2 right-1 !-translate-y-1/2 size-8 cursor-pointer rounded-md",
                          "text-destructive/90 transition-[opacity,transform,colors] duration-150",
                          "hover:bg-destructive/15 hover:text-destructive active:scale-95",
                        )}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // TODO: terminate via API
                        }}
                      >
                        <Trash2Icon className="size-4 shrink-0" />
                        <span className="sr-only">Terminate</span>
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  );
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
