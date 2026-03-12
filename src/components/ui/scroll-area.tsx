import { forwardRef, type HTMLAttributes } from 'react';

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ children, className = '', style, ...props }, ref) => (
    <div
      ref={ref}
      className={`overflow-auto ${className}`}
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.08) transparent',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  ),
);

ScrollArea.displayName = 'ScrollArea';
