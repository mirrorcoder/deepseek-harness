// dsh-ext-remote-console — let the deployment declare its own page an operator console.
//
// WHAT THE CLIENT DOES BY DEFAULT
//
// The web client decides whether to offer the "privileged surface" from one
// fact, `connection.isLoopback`, which is true when the page authority is a
// loopback host or when the page declares it owns the Host
// (`globalThis.__DSH_TRANSPORT__.ownsHost`). Anything else is treated as a
// browser tab that might belong to a passer-by, so two things are withheld:
//
//   * settings stop persisting to the harness home and become process-local,
//     which is why Settings → Models answers "settings are unavailable in this
//     browser" and no API key can be saved there;
//   * General settings lose the "open configuration file" action.
//
// WHY A DEPLOYMENT MAY OVERRIDE IT
//
// Loopback is a stand-in for "only the operator can reach this page". A
// single-operator deployment behind TLS, a reverse-proxy login and the
// harness's own signed session cookie satisfies that property without
// satisfying the stand-in. It also grants nothing new: whoever is through
// that door already drives an agent that runs shell commands on this host,
// so withholding the settings form protects nothing — it only forces the
// operator to tunnel a loopback port to change a model.
//
// This is a deployment decision, never a default: `enabled` is off unless a
// composition turns it on, and the shipped patch in this bundle turns it on
// for exactly this deployment (see the comment there).
//
// HOW
//
// One structured index-injection row assigns the page global in the head,
// ahead of the client bundle. No transport hooks are supplied, so the page
// keeps the ordinary HTTP + WebSocket carrier; `ownsHost` is the only fact
// this changes.
import z from '@deepseek-ai/schemastery'

export const name = 'ext-remote-console'
export const inject = ['webServer']

export const Config = z.object({
  /** Off unless a deployment decides otherwise; installing this package elevates nothing. */
  enabled: z.boolean().default(false),
})

/** The page global the client reads when deciding the surface is privileged. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/** The single index row this plugin contributes. */
export function consoleInjection() {
  return { kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } }
}

export function apply(ctx, config) {
  if (!config.enabled) return
  ctx.on('webserver/index-inject', (table) => {
    // Rows are read fresh at emit time, so each render gets its own value.
    table.push(consoleInjection())
  })
}
