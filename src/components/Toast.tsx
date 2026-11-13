import { useToasts } from "../stores/toastStore";

export function ToastHost() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((item) => {
        const busy = item.kind === "progress" && item.ratio == null;
        const width = item.kind === "progress" && item.ratio != null ? `${Math.round(Math.min(1, Math.max(0, item.ratio)) * 100)}%` : undefined;
        return (
          <button
            key={item.id}
            type="button"
            className="fp-toast pointer-events-auto"
            data-kind={item.kind}
            title={item.text}
            onClick={() => dismiss(item.id)}
          >
            <span className="fp-toast-text">{item.text}</span>
            {item.kind === "progress" && (
              <span className="fp-toast-bar" data-busy={busy ? "true" : undefined} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={width ? Math.round((item.ratio ?? 0) * 100) : undefined}>
                <span style={!busy && width ? { width } : undefined} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
