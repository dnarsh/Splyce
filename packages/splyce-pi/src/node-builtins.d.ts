// Minimal ambient typings for the Node built-ins snapshots.ts uses.
// Owned by TD-24; deliberately narrow, and deliberately NOT @types/node (TD-11 owns the package manifest).
// Delete this file when @types/node is adopted.

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: {
      encoding: "utf8";
      maxBuffer?: number;
      stdio?: readonly ("ignore" | "pipe")[];
    },
  ): string;
}

declare module "node:fs" {
  export interface Stats {
    isSymbolicLink(): boolean;
    isFile(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function readFileSync(path: string): Uint8Array;
  export function readlinkSync(path: string): string;
}

declare module "node:path" {
  const path: {
    join(...parts: string[]): string;
    posix: {
      normalize(path: string): string;
      isAbsolute(path: string): boolean;
    };
  };
  export default path;
}
