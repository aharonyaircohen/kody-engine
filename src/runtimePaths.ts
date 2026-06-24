import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"

function safeKey(cwd: string): string {
  return crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 16)
}

export function runtimeStatePath(cwd: string, ...segments: string[]): string {
  const root = process.env.KODY_RUNTIME_DIR?.trim() || path.join(os.tmpdir(), "kody-runtime")
  return path.join(root, safeKey(cwd), ...segments)
}
