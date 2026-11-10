import { useEffect, useRef } from "react";
import { diskFolder, shortPath } from "../lib/format";
import { useApp } from "../stores/appStore";
import { dragHeight } from "./DragBar";

export function CommandLine() {
  const command = useApp((state) => state.command);
  const setCommand = useApp((state) => state.setCommand);
  const historyStep = useApp((state) => state.historyStep);
  const runCommand = useApp((state) => state.runCommand);
  const cancelCommand = useApp((state) => state.cancelCommand);
  const running = useApp((state) => state.running);
  const output = useApp((state) => state.output);
  const outputOpen = useApp((state) => state.outputOpen);
  const outputHeight = useApp((state) => state.outputHeight);
  const setOutputHeight = useApp((state) => state.setOutputHeight);
  const setOutputOpen = useApp((state) => state.setOutputOpen);
  const path = diskFolder(useApp((state) => state.panels[state.active].path));
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [output]);
  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)]">
      {outputOpen && output && (
        <div className="relative">
          <div
            className="fp-hdrag"
            title="Drag to resize the output"
            onDoubleClick={() => setOutputHeight(160)}
            onPointerDown={(event) => {
              if (box.current) dragHeight(event, box.current, 72, window.innerHeight * 0.7, setOutputHeight);
            }}
          />
          <pre ref={box} className="fp-output" style={{ height: outputHeight }}>{output}</pre>
          <button className="btn sm absolute right-2 top-3" onClick={() => setOutputOpen(false)}>Hide</button>
        </div>
      )}
      <form
        className="flex h-9 items-center gap-2 px-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runCommand();
        }}
      >
        <span className="max-w-56 truncate font-mono text-xs text-[var(--muted)]" title={path}>{shortPath(path)}&gt;</span>
        <input
          className="field h-7 min-w-0 flex-1 font-mono"
          value={command}
          placeholder="Command in this folder"
          spellCheck={false}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              historyStep(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              historyStep(1);
            }
          }}
        />
        <button className="btn sm primary" type="submit" disabled={running || !command.trim()}>Run</button>
        {running && <button className="btn sm" type="button" onClick={() => void cancelCommand()}>Stop</button>}
      </form>
    </div>
  );
}
