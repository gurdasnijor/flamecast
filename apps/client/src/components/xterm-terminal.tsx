import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface XtermTerminalProps {
  /** Stream of data chunks to write to the terminal */
  data?: string[];
  /** Called when the user types into the terminal */
  onInput?: (data: string) => void;
  /** Additional CSS class for the container */
  className?: string;
}

/**
 * Renders an xterm.js terminal that auto-fits its container.
 *
 * Writes incoming `data` chunks and forwards user keystrokes via `onInput`.
 */
export function XtermTerminal({ data, onInput, className }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);

  // Initialize terminal once
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Geist Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "hsl(0 0% 3.9%)",
        foreground: "hsl(0 0% 98%)",
        cursor: "hsl(0 0% 98%)",
        selectionBackground: "hsla(0, 0%, 98%, 0.15)",
      },
      convertEol: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Fit after a frame so the container has dimensions
    requestAnimationFrame(() => fit.fit());

    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = 0;

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  // Forward user input
  useEffect(() => {
    const term = termRef.current;
    if (!term || !onInput) return;
    const disposable = term.onData(onInput);
    return () => disposable.dispose();
  }, [onInput]);

  // Write new data chunks incrementally
  useEffect(() => {
    const term = termRef.current;
    if (!term || !data) return;
    for (let i = writtenRef.current; i < data.length; i++) {
      term.write(data[i]);
    }
    writtenRef.current = data.length;
  }, [data]);

  // Resize on container size changes
  useEffect(() => {
    const container = containerRef.current;
    const fit = fitRef.current;
    if (!container || !fit) return;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore fit errors during teardown
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%", minHeight: 0 }}
    />
  );
}
