import { Fragment, useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { XtermTerminal } from "@/components/xterm-terminal";
import {
  FolderTreeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
  ActivityIcon,
  PowerOffIcon,
  SkullIcon,
} from "lucide-react";
import type { RuntimeInstance } from "@flamecast/protocol/runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalTab {
  id: string;
  label: string;
  data: string[];
  /** "running" | "closing" | "closed" */
  state: "running" | "closing" | "closed";
}

interface RuntimeInspectPanelProps {
  instance: RuntimeInstance;
  onStart?: () => void;
  isStarting?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RuntimeInspectPanel({
  instance,
  onStart,
  isStarting,
}: RuntimeInspectPanelProps) {
  const isRunning = instance.status === "running";

  if (!isRunning) {
    return <InactiveRuntimeView instance={instance} onStart={onStart} isStarting={isStarting} />;
  }

  return <ActiveRuntimeView instance={instance} />;
}

// ---------------------------------------------------------------------------
// Inactive view
// ---------------------------------------------------------------------------

function InactiveRuntimeView({
  instance,
  onStart,
  isStarting,
}: {
  instance: RuntimeInstance;
  onStart?: () => void;
  isStarting?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-muted">
        <PowerOffIcon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{instance.name}</h3>
        <p className="text-sm text-muted-foreground">
          This runtime instance is currently{" "}
          <Badge
            variant="outline"
            className={cn(
              instance.status === "paused"
                ? "text-yellow-700 dark:text-yellow-400"
                : "text-muted-foreground",
            )}
          >
            {instance.status}
          </Badge>
        </p>
      </div>
      {onStart && (
        <Button onClick={onStart} disabled={isStarting} className="mt-2">
          {isStarting ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <PlayIcon className="size-4" />
          )}
          {instance.status === "paused" ? "Resume" : "Start"} instance
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active view — tabs: Filesystem | Terminal | Traces
// ---------------------------------------------------------------------------

function ActiveRuntimeView({ instance }: { instance: RuntimeInstance }) {
  const [activeTab, setActiveTab] = useState("filesystem");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <h3 className="truncate text-sm font-semibold">{instance.name}</h3>
        <Badge
          variant="outline"
          className="shrink-0 text-green-700 dark:text-green-400"
        >
          running
        </Badge>
      </div>

      {/* Tabbed content */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="filesystem">
              <FolderTreeIcon className="size-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <TerminalIcon className="size-3.5" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="traces">
              <ActivityIcon className="size-3.5" />
              Traces
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="filesystem" className="mt-0 min-h-0 flex-1 overflow-auto">
          <FilesystemTab instance={instance} />
        </TabsContent>

        <TabsContent value="terminal" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <TerminalTabsContainer instance={instance} />
        </TabsContent>

        <TabsContent value="traces" className="mt-0 min-h-0 flex-1 overflow-auto">
          <TracesTab instance={instance} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filesystem tab (placeholder — hooks into existing filesystem snapshot infra)
// ---------------------------------------------------------------------------

function FilesystemTab({ instance: _instance }: { instance: RuntimeInstance }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      <div className="space-y-2 text-center">
        <FolderTreeIcon className="mx-auto size-8 text-muted-foreground/50" />
        <p>Filesystem preview for this runtime instance.</p>
        <p className="text-xs">
          Connect to a session on this runtime to browse its workspace files.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal tabs — add / remove with graceful close + hard kill
// ---------------------------------------------------------------------------

let terminalCounter = 0;

function TerminalTabsContainer({ instance: _instance }: { instance: RuntimeInstance }) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    terminalCounter++;
    return [
      {
        id: `term-${terminalCounter}`,
        label: `Terminal ${terminalCounter}`,
        data: [
          `\x1b[1;32m$ Connected to runtime\x1b[0m\r\n`,
          `\x1b[90mType commands here...\x1b[0m\r\n`,
        ],
        state: "running",
      },
    ];
  });
  const [activeTerminal, setActiveTerminal] = useState<string>(tabs[0]?.id ?? "");
  const [closingTab, setClosingTab] = useState<TerminalTab | null>(null);

  const addTab = useCallback(() => {
    terminalCounter++;
    const newTab: TerminalTab = {
      id: `term-${terminalCounter}`,
      label: `Terminal ${terminalCounter}`,
      data: [
        `\x1b[1;32m$ Connected to runtime\x1b[0m\r\n`,
      ],
      state: "running",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTerminal(newTab.id);
  }, []);

  const requestClose = useCallback((tab: TerminalTab) => {
    if (tab.state === "closed") {
      // Already closed — just remove
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tab.id);
        return next;
      });
      setActiveTerminal((current) => {
        if (current === tab.id) {
          const remaining = tabs.filter((t) => t.id !== tab.id);
          return remaining[remaining.length - 1]?.id ?? "";
        }
        return current;
      });
      return;
    }
    // Show confirmation dialog
    setClosingTab(tab);
  }, [tabs]);

  const handleGracefulClose = useCallback(() => {
    if (!closingTab) return;
    const tabId = closingTab.id;
    // Mark as closing (sends SIGTERM-equivalent)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              state: "closing" as const,
              data: [...t.data, `\r\n\x1b[33mSending close signal...\x1b[0m\r\n`],
            }
          : t,
      ),
    );
    // Simulate process exit after a short delay
    setTimeout(() => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        return next;
      });
      setActiveTerminal((current) => {
        if (current === tabId) {
          const remaining = tabs.filter((t) => t.id !== tabId);
          return remaining[remaining.length - 1]?.id ?? "";
        }
        return current;
      });
    }, 500);
    setClosingTab(null);
  }, [closingTab, tabs]);

  const handleHardKill = useCallback(() => {
    if (!closingTab) return;
    const tabId = closingTab.id;
    // Immediately remove
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveTerminal((current) => {
      if (current === tabId) {
        const remaining = tabs.filter((t) => t.id !== tabId);
        return remaining[remaining.length - 1]?.id ?? "";
      }
      return current;
    });
    setClosingTab(null);
  }, [closingTab, tabs]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      // Echo input back to terminal and append to data
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTerminal ? { ...t, data: [...t.data, data] } : t,
        ),
      );
    },
    [activeTerminal],
  );

  return (
    <>
      {/* Terminal tab bar */}
      <div className="flex shrink-0 items-center gap-0.5 border-b bg-muted/30 px-2 pt-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "group/tab flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTerminal === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveTerminal(tab.id)}
          >
            <TerminalIcon className="size-3" />
            <span>{tab.label}</span>
            {tab.state === "closing" && (
              <LoaderCircleIcon className="size-3 animate-spin text-yellow-500" />
            )}
            <button
              type="button"
              className="ml-1 flex size-4 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-muted group-hover/tab:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                requestClose(tab);
              }}
              title="Close terminal"
            >
              <XIcon className="size-3" />
            </button>
          </button>
        ))}
        <button
          type="button"
          className="ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={addTab}
          title="New terminal"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {/* Terminal content */}
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn("h-full", activeTerminal === tab.id ? "block" : "hidden")}
          >
            <XtermTerminal
              data={tab.data}
              onInput={handleTerminalInput}
              className="h-full"
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border px-4 py-2 transition-colors hover:bg-muted"
              onClick={addTab}
            >
              <PlusIcon className="size-4" />
              Open a terminal
            </button>
          </div>
        )}
      </div>

      {/* Close confirmation dialog */}
      <AlertDialog open={!!closingTab} onOpenChange={(open) => !open && setClosingTab(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              {closingTab?.label ?? "This terminal"} has a running process. How would you like to
              close it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleGracefulClose}>
              Close gracefully
            </AlertDialogAction>
            <AlertDialogAction variant="destructive" onClick={handleHardKill}>
              <SkullIcon className="size-4" />
              Force kill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Traces tab — shows traces from ALL sessions on this runtime instance
// ---------------------------------------------------------------------------

function TracesTab({ instance }: { instance: RuntimeInstance }) {
  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 10_000,
  });

  // Filter sessions that belong to this runtime instance
  const runtimeSessions = useMemo(() => {
    if (!sessions) return [];
    return sessions.filter((s) => s.runtime === instance.name);
  }, [sessions, instance.name]);

  if (!sessions) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (runtimeSessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <div className="space-y-2 text-center">
          <ActivityIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p>No active sessions on this runtime.</p>
          <p className="text-xs">Start a session to see traces here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {runtimeSessions.map((session) => (
        <div key={session.id} className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0">
              {session.agentName}
            </Badge>
            <code className="truncate text-xs text-muted-foreground">{session.id.slice(0, 12)}...</code>
            <Badge
              variant="outline"
              className={cn(
                "ml-auto shrink-0",
                session.status === "active"
                  ? "text-green-700 dark:text-green-400"
                  : "text-muted-foreground",
              )}
            >
              {session.status}
            </Badge>
          </div>
          {session.logs.length === 0 ? (
            <p className="pl-2 text-xs text-muted-foreground">No trace entries yet.</p>
          ) : (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
              {session.logs.map((log, index) => (
                <Fragment key={index}>
                  {index > 0 && <Separator className="my-1" />}
                  <div className="flex items-start gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <Badge variant={getTraceVariant(log.type)} className="shrink-0 text-[10px]">
                      {log.type}
                    </Badge>
                    <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  </div>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTraceVariant(type: string): "default" | "secondary" | "destructive" | "outline" {
  switch (type) {
    case "rpc":
      return "secondary";
    case "initialized":
    case "session_created":
      return "default";
    case "prompt_sent":
    case "prompt_completed":
      return "secondary";
    case "permission_approved":
      return "default";
    case "permission_rejected":
    case "permission_cancelled":
    case "killed":
      return "destructive";
    default:
      return "outline";
  }
}
