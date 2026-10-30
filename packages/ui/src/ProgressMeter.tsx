export function ProgressMeter({ value, label }: { value: number; label: string }) {
  return <div className="dash-progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
    <div className="dash-progress-fill" style={{ width: `${value}%` }} />
  </div>;
}
