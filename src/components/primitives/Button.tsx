import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

const BASE =
  'inline-flex items-center justify-center rounded-[5px] px-[14px] py-[7px] text-meta font-medium transition-colors active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)] disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-[var(--color-agent-master)] text-[var(--color-bg-primary)] hover:brightness-110',
  secondary:
    'border border-[var(--color-agent-master)] text-[var(--color-agent-master)] hover:bg-bg-subtle',
  ghost: 'text-fg-secondary hover:bg-bg-subtle',
};

export function Button({
  children,
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: PropsWithChildren<Props>) {
  return (
    <button type={type} className={`${BASE} ${VARIANT[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
