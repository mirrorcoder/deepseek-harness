// The output schemas of the host tools, kept apart from the plugin body.
//
// `defineTool` validates them strictly: EVERY object node must say
// `additionalProperties` explicitly, arrays must declare their items. A schema
// that breaks that rule throws while the plugin is mounting, and a plugin that
// throws there mounts nothing at all — no tools, no settings section, no error
// anyone sees. That is exactly how host access shipped switched-on and invisible.
// Keeping the schemas here lets the test suite hold them to the same rule.

/** What `host_bash` returns. */
export const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    timedOut: { type: 'boolean' },
    cwd: { type: 'string' },
  },
}

/** What `find_projects` returns. */
export const PROJECTS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          hostPath: { type: 'string' },
          name: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string' } },
          changedAt: { type: 'number' },
        },
      },
    },
    scanned: { type: 'integer' },
    truncated: { type: 'boolean' },
  },
}

/** What `add_workspace` returns. */
export const WORKSPACE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string' },
    hostPath: { type: 'string' },
  },
}
