interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

export function Skeleton({ width, height = 16, borderRadius = 8, className }: SkeletonProps) {
  return (
    <>
      <style>{`
        @keyframes skeletonPulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>
      <div
        className={`bg-wc-surface ${className ?? ''}`}
        style={{
          width: width ?? '100%',
          height,
          borderRadius,
          animation: 'skeletonPulse 1.8s ease-in-out infinite',
        }}
      />
    </>
  );
}
