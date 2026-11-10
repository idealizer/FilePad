import { useToasts } from "../stores/toastStore";

const colors = { success: "var(--ok)", error: "var(--danger)", warning: "var(--warn)" };

export function ToastHost() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((item) => (
        <button
          key={item.id}
          className="pointer-events-auto rounded-xl border px-3 py-2 text-left text-sm shadow-lg"
          style={{ background: "var(--surface)", borderColor: colors[item.kind] }}
          onClick={() => dismiss(item.id)}
        >
          <span className="mb-1 block h-1 w-8 rounded" style={{ background: colors[item.kind] }} />
          {item.text}
        </button>
      ))}
    </div>
  );
}
