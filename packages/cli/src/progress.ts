import { formatDuration } from './estimate.ts';

export interface MutationProgress {
  completed: number;
  total: number;
  elapsedMs: number;
  remainingMs: number;
}

/** Draw on stderr only. End the line before ordinary logs, errors or the final report. */
export function terminalProgress(stream: NodeJS.WriteStream) {
  let visible = false;
  let drawnAt = -Infinity;
  const endLine = () => {
    if (visible) stream.write('\n');
    visible = false;
  };
  return {
    log(message: string) {
      endLine();
      stream.write(message + '\n');
    },
    onProgress(state: MutationProgress | undefined) {
      if (!state) return endLine();
      const now = performance.now();
      if (visible && state.completed !== state.total && now - drawnAt < 100) return;
      const percent = Math.floor(100 * state.completed / state.total);
      const label = `${percent}% ${state.completed}/${state.total}  elapsed ${formatDuration(state.elapsedMs)}  ETA ~${formatDuration(state.remainingMs)}`;
      const columns = Math.max(1, (stream.columns || 80) - 1);
      const width = Math.min(24, columns - label.length - 3);
      const filled = Math.floor(width * state.completed / state.total);
      const bar = width >= 4 ? `[${'='.repeat(filled)}${'-'.repeat(width - filled)}] ` : '';
      stream.write(`\r\x1b[2K${(bar + label).slice(0, columns)}`);
      visible = true;
      drawnAt = now;
    },
  };
}
