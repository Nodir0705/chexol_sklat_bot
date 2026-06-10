interface Props {
  value: number;
  max: number;
  className?: string;
}

export default function ProgressBar({ value, max, className = '' }: Props) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    pct > 60 ? 'bg-green-500' : pct > 25 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className={`w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ${className}`}>
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
