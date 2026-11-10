import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExtractedLine, ExtractedRun } from "./parse";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const NIQQUD = /[\u0591-\u05C7]/g;
const HEBREW = /[\u0590-\u05FF]/;

function clean(value: string): string {
  return String(value ?? "").replace(NIQQUD, "").replace(/\s+/g, " ").trim();
}

/**
 * PDF text is often emitted in visual order for RTL runs. A run that starts
 * with a Hebrew final letter (which can only end a word) is almost certainly
 * reversed; reverse it and re-reverse numeric/Latin tokens so they stay
 * readable. This is a heuristic — see KNOWN_ISSUES.
 */
function fixRtlRun(value: string): string {
  const text = value.trim();
  if (!text || !/[\u0590-\u05FF]/.test(text)) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if (!"ךםןףץ".includes(first) || "ךםןףץ".includes(last)) return text;
  const reversed = [...text].reverse().join("");
  return reversed.replace(/[0-9A-Za-z][0-9A-Za-z.,%/-]*/g, (token) => [...token].reverse().join(""));
}

type RawRun = { text: string; x: number; y: number; width: number; height: number };

export async function extractPdfLines(file: File): Promise<ExtractedLine[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const lines: ExtractedLine[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const runs: { text: string; x: number; y: number; width: number; height: number }[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const text = clean(item.str);
        if (!text) continue;
        const transform = item.transform as number[];
        runs.push({
          text: fixRtlRun(text),
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: item.width ?? 0,
          height: item.height ?? 0,
        });
      }
      const sorted = [...runs].sort((a, b) => b.y - a.y || b.x - a.x);
      const groups: RawRun[][] = [];
      for (const run of sorted) {
        const group = groups.find((candidate) => Math.abs(candidate[0].y - run.y) <= Math.max(2, run.height * 0.5));
        if (group) group.push(run);
        else groups.push([run]);
      }
      for (const group of groups) {
        group.sort((a, b) => b.x - a.x);
        const text = group.map((run) => run.text).join(" ").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const lineRuns: ExtractedRun[] = group.map((run) => ({ text: run.text, x: run.x, width: run.width }));
        lines.push({ page: pageNumber, y: group[0].y, text, runs: lineRuns });
      }
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}

export function hasExtractableText(lines: ExtractedLine[]): boolean {
  return lines.some((line) => HEBREW.test(line.text) || /[A-Za-z0-9]/.test(line.text));
}
