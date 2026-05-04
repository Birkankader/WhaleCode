/**
 * Phase 7 Step 6 — Banner primitive unit tests.
 *
 * Wrappers (ErrorBanner / StashBanner / AutoApproveSuspendedBanner)
 * have their own integration tests covering the store-driven copy and
 * action wiring. These tests focus on the primitive's own contract:
 * variant accent colours, ARIA wiring, dataAttrs forwarding, dismiss
 * handling, and the actions slot.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { Bug } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Banner } from './Banner';

describe('Banner — visibility', () => {
  it('renders nothing when visible is false', () => {
    render(
      <Banner variant="info" visible={false} testId="banner">
        <span>hidden</span>
      </Banner>,
    );
    expect(screen.queryByTestId('banner')).toBeNull();
  });

  it('renders the children when visible is true', () => {
    render(
      <Banner variant="info" visible testId="banner">
        <span>hello</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root).toBeInTheDocument();
    expect(root).toHaveTextContent('hello');
  });
});

describe('Banner — variants', () => {
  it('error variant tags data-variant + applies status-failed accent', () => {
    render(
      <Banner variant="error" visible testId="banner">
        <span>boom</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root).toHaveAttribute('data-variant', 'error');
    expect(root.getAttribute('style') ?? '').toContain(
      'var(--color-status-failed)',
    );
  });

  it('warning variant uses status-pending accent', () => {
    render(
      <Banner variant="warning" visible testId="banner">
        <span>warn</span>
      </Banner>,
    );
    expect(screen.getByTestId('banner').getAttribute('style') ?? '').toContain(
      'var(--color-status-pending)',
    );
  });

  it('info variant uses status-running accent', () => {
    render(
      <Banner variant="info" visible testId="banner">
        <span>info</span>
      </Banner>,
    );
    expect(screen.getByTestId('banner').getAttribute('style') ?? '').toContain(
      'var(--color-status-running)',
    );
  });
});

describe('Banner — ARIA', () => {
  it("default role is 'status' / aria-live polite", () => {
    render(
      <Banner variant="info" visible testId="banner">
        <span>x</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-live', 'polite');
  });

  it("role='alert' + assertive when caller overrides", () => {
    render(
      <Banner
        variant="error"
        visible
        testId="banner"
        role="alert"
        ariaLive="assertive"
      >
        <span>x</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root).toHaveAttribute('role', 'alert');
    expect(root).toHaveAttribute('aria-live', 'assertive');
  });

  it('forwards aria-label when provided', () => {
    render(
      <Banner
        variant="info"
        visible
        testId="banner"
        ariaLabel="Apply summary"
      >
        <span>x</span>
      </Banner>,
    );
    expect(screen.getByTestId('banner')).toHaveAttribute(
      'aria-label',
      'Apply summary',
    );
  });
});

describe('Banner — dataAttrs', () => {
  it('forwards dataAttrs as data-* on the root', () => {
    render(
      <Banner
        variant="info"
        visible
        testId="banner"
        dataAttrs={{ kind: 'conflict', flavour: 'base' }}
      >
        <span>x</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root).toHaveAttribute('data-kind', 'conflict');
    expect(root).toHaveAttribute('data-flavour', 'base');
  });

  it('skips undefined dataAttrs values rather than rendering "undefined"', () => {
    render(
      <Banner
        variant="info"
        visible
        testId="banner"
        dataAttrs={{ 'category-kind': undefined }}
      >
        <span>x</span>
      </Banner>,
    );
    const root = screen.getByTestId('banner');
    expect(root.getAttribute('data-category-kind')).toBeNull();
  });
});

describe('Banner — icon', () => {
  it('renders the default AlertCircle icon when icon is not specified', () => {
    const { container } = render(
      <Banner variant="info" visible testId="banner">
        <span>x</span>
      </Banner>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('omits the icon when icon=null is passed (StashBanner contract)', () => {
    const { container } = render(
      <Banner variant="info" visible testId="banner" icon={null}>
        <span>x</span>
      </Banner>,
    );
    // Only the dismiss SVG should exist if a dismiss handler is set; with
    // none, no SVGs are rendered.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a custom icon when one is provided', () => {
    const { container } = render(
      <Banner variant="info" visible testId="banner" icon={Bug}>
        <span>x</span>
      </Banner>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});

describe('Banner — dismiss', () => {
  it('renders no × button when onDismiss is omitted', () => {
    render(
      <Banner variant="info" visible testId="banner">
        <span>x</span>
      </Banner>,
    );
    expect(screen.queryByTestId('banner-dismiss')).toBeNull();
  });

  it('renders the × button + invokes onDismiss on click', () => {
    const onDismiss = vi.fn();
    render(
      <Banner
        variant="info"
        visible
        testId="banner"
        onDismiss={onDismiss}
        dismissLabel="Close"
      >
        <span>x</span>
      </Banner>,
    );
    const btn = screen.getByTestId('banner-dismiss');
    expect(btn).toHaveAttribute('aria-label', 'Close');
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('falls back to "Dismiss" aria-label when dismissLabel is omitted', () => {
    render(
      <Banner variant="info" visible testId="banner" onDismiss={() => {}}>
        <span>x</span>
      </Banner>,
    );
    expect(screen.getByTestId('banner-dismiss')).toHaveAttribute(
      'aria-label',
      'Dismiss',
    );
  });
});

describe('Banner — actions slot', () => {
  it('renders nothing when actions is omitted', () => {
    render(
      <Banner variant="info" visible testId="banner">
        <span>body</span>
      </Banner>,
    );
    expect(screen.queryByTestId('banner-action')).toBeNull();
  });

  it('renders provided action nodes between content and dismiss', () => {
    render(
      <Banner
        variant="info"
        visible
        testId="banner"
        onDismiss={() => {}}
        actions={
          <button type="button" data-testid="banner-action">
            do thing
          </button>
        }
      >
        <span>body</span>
      </Banner>,
    );
    expect(screen.getByTestId('banner-action')).toBeInTheDocument();
    // Both action and dismiss coexist.
    expect(screen.getByTestId('banner-dismiss')).toBeInTheDocument();
  });
});
