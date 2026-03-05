import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import { MemoryRouter } from 'react-router';
import { AppShell } from '../components/layout/AppShell';

// Mock react-xtermjs to avoid canvas/WebGL dependency in jsdom
vi.mock('react-xtermjs', () => ({
  useXTerm: () => ({
    instance: null,
    ref: { current: null },
  }),
}));

// Mock @xterm/addon-fit
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

// Mock bindings (tauri-specta generated file)
vi.mock('../bindings', () => ({
  commands: {
    startStream: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('AppShell layout (FOUN-03)', () => {
  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd === 'start_stream') return undefined;
      if (cmd === 'get_task_count') return 0;
    });
  });

  it('renders sidebar and main content areas', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <div data-testid="test-child">content</div>
        </AppShell>
      </MemoryRouter>
    );
    expect(screen.getByTestId('sidebar')).toBeDefined();
    expect(screen.getByTestId('main-content')).toBeDefined();
  });

  it('renders children inside the main content area', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <div data-testid="test-child">content</div>
        </AppShell>
      </MemoryRouter>
    );
    expect(screen.getByTestId('test-child')).toBeDefined();
  });

  it('renders output console area', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <div data-testid="output-console">terminal placeholder</div>
        </AppShell>
      </MemoryRouter>
    );
    expect(screen.getByTestId('output-console')).toBeDefined();
  });
});
