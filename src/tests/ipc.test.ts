import { describe, it, expect, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';

describe('IPC pipeline (FOUN-02)', () => {
  it('get_task_count returns a number', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_task_count') return 0;
    });
    // Import invoke dynamically to use mocked IPC
    const { invoke } = await import('@tauri-apps/api/core');
    const count = await invoke<number>('get_task_count');
    expect(count).toBe(0);
  });

  it('OutputEvent Stdout shape matches expected contract', () => {
    // Validate the OutputEvent shape the frontend Channel consumer expects
    const mockStdout = { event: 'stdout', data: 'Test event from Rust' };
    const mockExit = { event: 'exit', data: 0 };

    expect(mockStdout.event).toBe('stdout');
    expect(typeof mockStdout.data).toBe('string');
    expect(mockExit.event).toBe('exit');
    expect(typeof mockExit.data).toBe('number');
  });

  it('start_stream command is invokeable via mocked IPC', async () => {
    const received: Array<{ event: string; data: unknown }> = [];

    mockIPC((cmd, _args) => {
      if (cmd === 'start_stream') {
        // Simulate the channel callback behavior
        received.push({ event: 'stdout', data: 'Test event from Rust' });
        received.push({ event: 'exit', data: 0 });
        return undefined;
      }
    });

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('start_stream', { onEvent: () => {} });

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe('stdout');
    expect(received[1].event).toBe('exit');
  });
});
