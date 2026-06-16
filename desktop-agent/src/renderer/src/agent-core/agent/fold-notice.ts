/**
 * P2 context-org — FRC (Function Results Cleanup) notice constants.
 *
 * Tool-result folding (Claude-Code Tier 1) replaces OLD tool *result* content
 * with a single placeholder. The model needs to know that this can happen so
 * the placeholder doesn't confuse it as an error. The notice text is injected
 * into the system prompt suffix.
 *
 * Both the placeholder and the notice live here so a rename in one place can't
 * silently drift from the other (the system prompt text references the
 * placeholder string verbatim — if the placeholder changes, the notice must
 * follow).
 *
 * See docs/2026-06-15-desktop-agent-上下文组织管理演进.md (P3).
 */

/** The exact placeholder string the trim compactor substitutes in. */
export const OLD_TOOL_RESULT_FOLDED_PLACEHOLDER =
  '[旧工具结果已折叠 · old tool result elided by context trimming]'

/** The FRC notice block — unconditionally appended to the system prompt
 *  suffix. Referenced by the fold compactor and the prompt assembly. */
export const FOLD_NOTICE_TEXT =
  '# 上下文折叠通知\n较旧的工具结果可能会被上下文管理折叠为占位符（"' +
  OLD_TOOL_RESULT_FOLDED_PLACEHOLDER +
  '"）。若需要完整结果，请重新调用相应工具。'
