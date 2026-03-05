import { useEffect, useRef } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from '@xterm/addon-fit';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import type { OutputEvent } from '../../bindings';

export function OutputConsole() {
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

  // Wire Channel to terminal on mount
  useEffect(() => {
    if (!instance) return;

    const channel = new Channel<OutputEvent>();
    channel.onmessage = (msg: OutputEvent) => {
      if (msg.event === 'stdout') {
        instance.writeln(msg.data);
      } else if (msg.event === 'stderr') {
        instance.writeln(`\x1b[31m${msg.data}\x1b[0m`);
      } else if (msg.event === 'exit') {
        instance.writeln(`\x1b[2m[Process exited with code ${msg.data}]\x1b[0m`);
      } else if (msg.event === 'error') {
        instance.writeln(`\x1b[31m[Error: ${msg.data}]\x1b[0m`);
      }
    };

    // Start the test stream - use .catch to suppress errors in non-Tauri env
    commands.startStream(channel).catch(() => {
      // Not running inside Tauri runtime (e.g., browser dev or test) - expected
    });

    return () => {
      // Channel cleanup: no explicit close API in tauri::Channel; GC handles it
    };
  }, [instance]);

  return (
    <div
      ref={ref}
      data-testid="output-console"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
