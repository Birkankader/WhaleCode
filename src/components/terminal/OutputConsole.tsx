import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from '@xterm/addon-fit';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { registerProcessOutput, unregisterProcessOutput } from '../../hooks/useProcess';
import type { OutputEvent } from '../../bindings';

function timestamp(): string {
  return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
}

const XTERM_OPTIONS = {
  scrollback: 10000,
  convertEol: true,
  theme: {
    background: '#0a0a0a',
    foreground: '#e2e2e2',
    cursor: '#e2e2e2',
  },
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
} as const;

interface OutputConsoleProps {
  processId?: string;
  channelRef?: (channel: Channel<OutputEvent>) => void;
  onOutput?: (event: OutputEvent) => void;
}

export function OutputConsole({ processId, channelRef, onOutput }: OutputConsoleProps = {}) {
  const options = useMemo(() => ({ options: XTERM_OPTIONS }), []);
  const { instance, ref } = useXTerm(options);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const registeredRef = useRef(false);

  // Stable writeEvent via ref (avoids dependency on instance in callbacks)
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  const writeEvent = useCallback((msg: OutputEvent) => {
    const term = instanceRef.current;
    if (!term) return;
    const ts = timestamp();
    if (msg.event === 'stdout') {
      term.writeln(`\x1b[2m${ts}\x1b[0m ${msg.data}`);
    } else if (msg.event === 'stderr') {
      term.writeln(`\x1b[2m${ts}\x1b[0m \x1b[31m${msg.data}\x1b[0m`);
    } else if (msg.event === 'exit') {
      term.writeln(`\x1b[2m${ts} [Process exited with code ${msg.data}]\x1b[0m`);
    } else if (msg.event === 'error') {
      term.writeln(`\x1b[2m${ts}\x1b[0m \x1b[31m[Error: ${msg.data}]\x1b[0m`);
    }
  }, []);

  // Load FitAddon once when terminal instance is first available
  useEffect(() => {
    if (!instance || initializedRef.current) return;
    initializedRef.current = true;

    const addon = new FitAddon();
    fitAddonRef.current = addon;
    instance.loadAddon(addon);
    addon.fit();
  }, [instance]);

  // Keep terminal sized to container on resize
  useEffect(() => {
    const observer = new ResizeObserver(() => fitAddonRef.current?.fit());
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  // Legacy/standalone mode: create own channel and stream
  useEffect(() => {
    if (!instance || processId !== undefined) return;

    let channel: Channel<OutputEvent>;
    try {
      channel = new Channel<OutputEvent>();
    } catch {
      return;
    }
    channel.onmessage = (msg: OutputEvent) => {
      writeEvent(msg);
      onOutput?.(msg);
    };

    if (channelRef) {
      channelRef(channel);
    }

    commands.startStream(channel).catch((err) => console.warn('startStream failed:', err));
  }, [instance, processId, channelRef, onOutput, writeEvent]);

  // Process mode: register for output via global event routing
  useEffect(() => {
    if (!instance || processId === undefined) return;
    if (registeredRef.current) return;
    registeredRef.current = true;

    registerProcessOutput(processId, (msg: OutputEvent) => {
      writeEvent(msg);
      onOutput?.(msg);
    });

    return () => {
      registeredRef.current = false;
      unregisterProcessOutput(processId);
    };
  }, [instance, processId, onOutput, writeEvent]);

  return (
    <div
      ref={ref}
      data-testid="output-console"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
