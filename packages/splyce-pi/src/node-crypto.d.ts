// Minimal ambient typings for the one `node:crypto` call module-plan.ts makes.
// Deliberately narrow, like node-sqlite.d.ts; delete when @types/node is adopted for this package.
declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
