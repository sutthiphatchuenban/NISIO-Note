import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "../src/files.ts";

// Synthetic, repeatable host-side measurements; not end-to-end WebView latency.
const root = mkdtempSync(join(tmpdir(), "nisio-benchmark-"));
function measure(run: () => unknown, iterations = 15) {
  run(); // Warm up separately.
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    run();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return {
    medianMs: Number(timings[Math.floor(timings.length / 2)]!.toFixed(3)),
    p95Ms: Number(timings[Math.ceil(timings.length * 0.95) - 1]!.toFixed(3)),
  };
}

try {
  const results = [1, 10].map((mb) => {
    const line = "A note line with words\n";
    const content = line.repeat(Math.ceil(mb * 1024 * 1024 / line.length)).slice(0, mb * 1024 * 1024);
    const path = join(root, `note-${mb}.txt`);
    const saved = writeTextFile({ path, content });
    if (!saved.ok) throw new Error(saved.error);
    const { content: text, ...metadata } = saved.file;
    const before = { ok: true, file: saved.file, recents: [] };
    const after = { ok: true, file: metadata, recents: [] };
    return {
      inputMiB: mb,
      saveResponse: {
        beforeBytes: Buffer.byteLength(JSON.stringify(before)),
        afterBytes: Buffer.byteLength(JSON.stringify(after)),
        serializeBefore: measure(() => JSON.stringify(before)),
        serializeAfter: measure(() => JSON.stringify(after)),
      },
      write: measure(() => {
        const result = writeTextFile({ path, content: text });
        if (!result.ok) throw new Error(result.error);
      }),
      read: measure(() => {
        const result = readTextFile(path);
        if (!result.ok || result.file.content !== content) throw new Error("Read-back mismatch");
      }),
    };
  });
  console.log(JSON.stringify({ bun: Bun.version, platform: process.platform, iterations: 15, results }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
