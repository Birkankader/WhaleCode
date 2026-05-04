/**
 * Phase 7 Step 4 — ElapsedCounter unit tests.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ElapsedCounter, formatElapsed } from './ElapsedCounter';

describe('formatElapsed', () => {
  it('returns "Xs" for sub-minute durations', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('returns "Xm Ys" for sub-hour durations', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(84_000)).toBe('1m 24s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
  });

  it('returns "Xh Ym" for hour-scale durations', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(3_660_000)).toBe('1h 1m');
    expect(formatElapsed(7_320_000)).toBe('2h 2m');
  });

  it('clamps negatives to 0', () => {
    expect(formatElapsed(-500)).toBe('0s');
  });
});

describe('ElapsedCounter component', () => {
  it('renders nothing for null elapsedMs', () => {
    const { container } = render(<ElapsedCounter elapsedMs={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for undefined elapsedMs', () => {
    const { container } = render(<ElapsedCounter elapsedMs={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders formatted elapsed for valid value', () => {
    render(<ElapsedCounter elapsedMs={84_000} />);
    expect(screen.getByTestId('elapsed-counter')).toHaveTextContent('1m 24s');
  });

  it('forwards aria-label with the formatted value', () => {
    render(<ElapsedCounter elapsedMs={5_000} />);
    expect(
      screen.getByTestId('elapsed-counter').getAttribute('aria-label'),
    ).toMatch(/Elapsed: 5s/);
  });

  it('exposes data-elapsed-ms for downstream test assertions', () => {
    render(<ElapsedCounter elapsedMs={42_500} />);
    expect(
      screen.getByTestId('elapsed-counter').getAttribute('data-elapsed-ms'),
    ).toBe('42500');
  });

  it('renders without icon when noIcon prop is set', () => {
    render(<ElapsedCounter elapsedMs={1_000} noIcon />);
    const node = screen.getByTestId('elapsed-counter');
    // No svg child element when noIcon set.
    expect(node.querySelector('svg')).toBeNull();
  });

  it('honors custom testId', () => {
    render(<ElapsedCounter elapsedMs={1_000} testId="my-elapsed" />);
    expect(screen.getByTestId('my-elapsed')).toBeInTheDocument();
  });
});
