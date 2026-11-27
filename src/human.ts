// Numbers and prose for the human format that terminal.ts has no helper
// for, kept apart so each command words them the same.
import { MEASURE, textWidth } from "./terminal.ts";

// Whole milliseconds under a second, then three significant figures, so
// a cost never shows more precision than a run repeats.
export function duration(ms: number): string {
  // 999.6 ms rounds to a second, not to "1000 ms".
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 999.5 ? s.toPrecision(3) : Math.round(s)} s`;
}

// Words wrapped to the measure, so text shown whole never runs past 80
// columns; each line after the first is indented as `hang`.
export function wrapped(text: string, first: string, hang: string): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(" ")) {
    if (!empty && textWidth(line) + 1 + textWidth(word) > MEASURE) {
      lines.push(line);
      line = hang + word;
      continue;
    }
    line += empty ? word : ` ${word}`;
    empty = false;
  }
  lines.push(line);
  return lines;
}
