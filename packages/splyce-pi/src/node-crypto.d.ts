// Minimal ambient typings for the `node:crypto` calls module-plan.ts and module-acquisition.ts make.
// Deliberately narrow, like node-sqlite.d.ts; delete when @types/node is adopted for this package.
declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export interface KeyObject {
    readonly type: string;
  }
  export function createPublicKey(pem: string): KeyObject;
  export function verify(
    algorithm: null,
    data: Uint8Array,
    key: KeyObject,
    signature: Uint8Array,
  ): boolean;
}
