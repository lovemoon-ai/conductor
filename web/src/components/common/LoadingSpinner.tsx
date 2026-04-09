'use client';

export function LoadingSpinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-6 h-6 border-2',
    lg: 'w-10 h-10 border-3',
  };

  return (
    <div className="relative">
      <div
        className={`${sizeClasses[size]} border-accent/20 rounded-full`}
      />
      <div
        className={`${sizeClasses[size]} border-transparent border-t-accent rounded-full animate-spin absolute inset-0`}
      />
    </div>
  );
}
