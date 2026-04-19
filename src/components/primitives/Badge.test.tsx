import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children and default neutral variant', () => {
    render(<Badge>hello</Badge>);
    const el = screen.getByText('hello');
    expect(el.getAttribute('data-variant')).toBe('neutral');
  });

  it('edited variant uses pending color', () => {
    render(<Badge variant="edited">edited</Badge>);
    const el = screen.getByText('edited');
    expect(el.getAttribute('data-variant')).toBe('edited');
    expect(el.style.color).toContain('pending');
  });

  it('added variant uses agent-master color', () => {
    render(<Badge variant="added">added</Badge>);
    const el = screen.getByText('added');
    expect(el.style.color).toContain('agent-master');
  });

  it('tooltip renders as title attribute', () => {
    render(
      <Badge variant="edited" tooltip="Modified from master's original plan">
        edited
      </Badge>,
    );
    const el = screen.getByText('edited');
    expect(el.getAttribute('title')).toBe("Modified from master's original plan");
  });
});
