import { cn } from './cn'

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

interface SpinnerProps {
  size?: SpinnerSize
  className?: string
  label?: string
}

const sizes: Record<SpinnerSize, string> = {
  xs: 'h-3 w-3 border',
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-8 w-8 border-[3px]',
}

export function Spinner({ size = 'md', className, label = "Loading…" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block rounded-full border-border border-t-primary animate-spin',
        sizes[size],
        className,
      )}
    />
  )
}

export function SpinnerOverlay({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10">
      <Spinner size="lg" label={label} />
    </div>
  )
}
