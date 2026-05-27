/**
 * Chat attachment handling.
 *
 * The dashboard inlines image attachments into the user-turn text as a
 * `[Image: <name> (<size>)]` descriptor followed by a `data:<mime>;base64,…`
 * URL (see Kody-Dashboard KodyChat `liveUserContent` / `engineUserContent`).
 * The chat loop hands the conversation to the agent as ONE flat string, so a
 * raw data URL is just a giant unreadable token-run — the agent literally
 * cannot see the picture, and (worse) it burns the prompt budget.
 *
 * `prepareAttachments` rewrites the turns so the image becomes something the
 * agent CAN see:
 *  - The LAST user turn's images are decoded to files in the runner workspace
 *    and the inline data URL is replaced with a line pointing the agent at the
 *    path. The agent's Read tool renders image files into the model's view.
 *  - Every other turn's data URLs are stripped to a short placeholder so
 *    megabytes of stale base64 don't bloat the prompt.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { ChatTurn } from "./session.js"

/**
 * Matches an inlined attachment: an optional `[Image: …]` / `[File: …]`
 * descriptor line, then the `data:<mime>;base64,<data>` URL the dashboard
 * emits. The base64 run ends at the first non-base64 char (newline), which is
 * exactly how the dashboard joins attachments + message text.
 */
const INLINE_ATTACHMENT_RE =
  /(?:\[(?:Image|File): ([^\]]*)\]\n)?data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
}

export interface PreparedPrompt {
  /** Turns with inline data URLs rewritten to file references / placeholders. */
  turns: ChatTurn[]
  /** Absolute paths of image files written for the current turn (may be empty). */
  imagePaths: string[]
}

function extFor(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? mime.split("/")[1]?.replace(/[^\w]/g, "") ?? "bin"
}

function attachmentsDir(cwd: string, sessionId: string): string {
  // Under .kody/tmp so it's clearly transient; the runner workspace is
  // ephemeral (or, for the live runner, never committed) so these files
  // never reach the repo.
  return path.join(cwd, ".kody", "tmp", "attachments", sessionId)
}

/**
 * Rewrite session turns so inlined image attachments are usable by the agent.
 * Only the LAST user turn's images are materialised to disk (that's the turn
 * the user is asking about); earlier turns keep just a short label.
 */
export function prepareAttachments(turns: ChatTurn[], cwd: string, sessionId: string): PreparedPrompt {
  const lastUserIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === "user") return i
    }
    return -1
  })()

  const imagePaths: string[] = []
  let imageCounter = 0

  const rewritten = turns.map((turn, idx) => {
    if (!turn.content.includes("base64,")) return turn
    const isLastUser = idx === lastUserIdx

    const newContent = turn.content.replace(
      INLINE_ATTACHMENT_RE,
      (_match, label: string | undefined, mime: string, data: string) => {
        const name = (label ?? "").trim() || "attachment"
        const isImage = mime.toLowerCase().startsWith("image/")

        if (!isLastUser || !isImage) {
          // History image, or a non-image file: don't feed base64 as text.
          return `[${isImage ? "Image" : "File"}: ${name}${isLastUser ? "" : " — omitted from history"}]`
        }

        // Current turn's image → write to disk so the Read tool can view it.
        try {
          const dir = attachmentsDir(cwd, sessionId)
          fs.mkdirSync(dir, { recursive: true })
          const filePath = path.join(dir, `${imageCounter}.${extFor(mime)}`)
          fs.writeFileSync(filePath, Buffer.from(data, "base64"))
          imageCounter += 1
          imagePaths.push(filePath)
          return `[Image "${name}" is attached — saved to ${filePath}. Use the Read tool on that exact path to view it before answering.]`
        } catch {
          // If the write fails, fall back to a label so we at least don't
          // dump base64 into the prompt.
          return `[Image: ${name} (could not be materialised)]`
        }
      },
    )

    if (newContent === turn.content) return turn
    return { ...turn, content: newContent }
  })

  return { turns: rewritten, imagePaths }
}
