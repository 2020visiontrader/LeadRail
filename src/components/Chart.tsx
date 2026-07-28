// Lightweight dependency-free bar chart.
export default function Chart({ data, height = 140 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-3" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center justify-end gap-1">
          <div className="w-full rounded-t bg-indigo-500" style={{ height: `${(d.value / max) * (height - 24)}px` }} title={`${d.label}: ${d.value}`} />
          <span className="text-[10px] text-slate-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
