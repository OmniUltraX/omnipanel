export function SkeletonLoader({ rows = 3, variant = 'list' }: { rows?: number; variant?: 'card' | 'list' | 'text' }) {
  return (
    <div className={`skeleton skeleton-${variant}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 0.1}s` }} />
      ))}
    </div>
  );
}
