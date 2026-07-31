/**
 * foundation-cli — small I/O seam so command functions are directly testable
 * (no process spawning): callers pass a CliIO, tests capture writes into an
 * array instead of hitting the real stdout/stderr.
 */
export interface CliIO {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(line.endsWith('\n') ? line : `${line}\n`)
}

export const processIo: CliIO = {
  stdout: (line) => write(process.stdout, line),
  stderr: (line) => write(process.stderr, line),
}

/** Test/programmatic helper: captures everything written instead of printing it. */
export function captureIo(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }
}
