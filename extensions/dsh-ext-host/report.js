// The judgements and the wording of host access — everything that needs no
// harness to decide. Kept out of index.js so it can be tested without the
// plugin's peer dependencies.

/**
 * Whether this session has approvals switched off — the full-access preset.
 * Asking there would be worse than pointless: the approval service resolves
 * every request as rejected under that policy, so the gate would BLOCK exactly
 * the mode the user chose to be unblocked in.
 */
export function approvalsOff(ctx, exec) {
  const approval = ctx.get?.('approval')
  const session = exec?.agent?.session
  if (approval === undefined || session === undefined) return false
  try {
    return (approval.overrideOf(session) ?? approval.config?.policy ?? 'ask') === 'never'
  } catch {
    return false
  }
}

/** A settings document may carry explicit undefined; spreading that erases a default. */
export function stripUndefined(section) {
  const out = {}
  for (const [key, value] of Object.entries(section ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** What one host command shows in the transcript. */
export function renderRun(value) {
  const parts = []
  const out = String(value?.stdout ?? '').trim()
  const err = String(value?.stderr ?? '').trim()
  if (out.length > 0) parts.push(out)
  if (err.length > 0) parts.push(`stderr:\n${err}`)
  if (value?.timedOut === true) parts.push('⏱ команда не уложилась в срок и была прервана')
  if (parts.length === 0) parts.push(value?.exitCode === 0 ? '(пусто, код 0)' : `(пусто, код ${value?.exitCode})`)
  if (value?.exitCode !== 0) parts.push(`код выхода: ${value?.exitCode}`)
  return parts.join('\n\n')
}

/** What a project scan shows. */
export function renderProjects(value) {
  const projects = value?.projects ?? []
  if (projects.length === 0) return 'Проектов не нашёл.'
  const lines = projects.map((project) => `• ${project.name} — ${project.hostPath} [${(project.kinds ?? []).join(', ')}]`)
  if (value?.truncated === true) lines.push('…список обрезан, сузь корень или подними limit')
  return lines.join('\n')
}
