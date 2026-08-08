/**
 * Minimal ambient typings for the node built-ins used by the model tests
 * ONLY (vitest runs in a node environment; see vite.config.ts).  The
 * project intentionally does not depend on @types/node — tsconfig pins
 * `types: ["vite/client"]` — and non-test model code never imports node
 * modules (browser-safety rule).
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
