export function StreamingIndicator(): React.ReactElement {
  return (
    <div className="flex justify-start rise">
      <div className="flex gap-2.5">
        <div
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-lg text-[10px] font-bold text-on-accent"
          style={{ backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))' }}
        >
          ◆
        </div>
        <div className="flex items-center gap-2.5 rounded-2xl rounded-tl-sm border border-line/70 bg-panel/60 px-4 py-3 shadow-lg backdrop-blur-sm">
          <span className="flex gap-1">
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent"
                style={{ animationDelay: d + 'ms' }}
              />
            ))}
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] text-faint">THINKING</span>
        </div>
      </div>
    </div>
  )
}
