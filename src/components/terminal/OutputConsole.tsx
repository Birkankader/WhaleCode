import { useEffect, useRef, useCallback } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from '@xterm/addon-fit';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import type { OutputEvent } from '../../bindings';

function timestamp(): string {
  return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
}

interface OutputConsoleProps {
  /** When provided, the console is bound to a specific process and does not auto-start a stream */
  processId?: string;
  /** Callback to expose the Channel to parent (for process-managed lifecycle) */
  channelRef?: (channel: Channel<OutputEvent>) => void;
  /** External handler for output events (used by ProcessPanel) */
  onOutput?: (event: OutputEvent) => void;
}

export function OutputConsole({ processId, channelRef, onOutput }: OutputConsoleProps = {}) {
  const { instance, ref } = useXTerm({
    options: {
      scrollback: 10000,
      convertEol: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e2e2e2',
        cursor: '#e2e2e2',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
    },
  });
  const fitAddon = useRef(new FitAddon());

  const writeEvent = useCallback(
    (msg: OutputEvent) => {
      if (!instance) return;
      const ts = timestamp();
      if (msg.event === 'stdout') {
        instance.writeln(`\x1b[2m${ts}\x1b[0m ${msg.data}`);
      } else if (msg.event === 'stderr') {
        instance.writeln(`\x1b[2m${ts}\x1b[0m \x1b[31m${msg.data}\x1b[0m`);
      } else if (msg.event === 'exit') {
        instance.writeln(
          `\x1b[2m${ts} [Process exited with code ${msg.data}]\x1b[0m`,
        );
      } else if (msg.event === 'error') {
        instance.writeln(
          `\x1b[2m${ts}\x1b[0m \x1b[31m[Error: ${msg.data}]\x1b[0m`,
        );
      }
    },
    [instance],
  );

  // Expose writeEvent so parent can forward events to this terminal
  const writeEventRef = useRef(writeEvent);
  writeEventRef.current = writeEvent;

  // Load FitAddon when terminal instance is ready
  useEffect(() => {
    if (instance) {
      instance.loadAddon(fitAddon.current);
      fitAddon.current.fit();
    }
  }, [instance]);

  // Keep terminal sized to container on resize
  useEffect(() => {
    const observer = new ResizeObserver(() => fitAddon.current?.fit());
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  // Wire Channel to terminal on mount (only when no processId — legacy/standalone mode)
  useEffect(() => {
    if (!instance || processId !== undefined) return;

    const channel = new Channel<OutputEvent>();
    channel.onmessage = (msg: OutputEvent) => {
      writeEventRef.current(msg);
      onOutput?.(msg);
    };

    if (channelRef) {
      channelRef(channel);
    }

    // Start the test stream - use .catch to suppress errors in non-Tauri env
    commands.startStream(channel).catch(() => {
      // Not running inside Tauri runtime (e.g., browser dev or test) - expected
    });

    return () => {
      // Channel cleanup: no explicit close API in tauri::Channel; GC handles it
    };
  }, [instance, processId, channelRef, onOutput]);

  // When processId is provided, create a channel and expose it to parent
  useEffect(() => {
    if (!instance || processId === undefined) return;

    const channel = new Channel<OutputEvent>();
    channel.onmessage = (msg: OutputEvent) => {
      writeEventRef.current(msg);
      onOutput?.(msg);
    };

    if (channelRef) {
      channelRef(channel);
    }

    return () => {
      // Channel cleanup: GC handles it
    };
  }, [instance, processId, channelRef, onOutput]);

  return (
    <div
      ref={ref}
      data-testid="output-console"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
