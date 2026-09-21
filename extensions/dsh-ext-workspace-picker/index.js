// dsh-ext-workspace-picker — the "Select Workspace Directory" dialog, made usable.
//
// The shipped browse backend lands an unqualified listing on the account's
// home directory (`/data` in this image) and reports every child directory
// equally, so picking the actual workspace means typing a path and scrolling
// past node_modules. This backend is that one, subclassed:
//
//   * an unqualified listing lands on the workspace root (the process cwd by
//     default) instead of the home directory;
//   * the breadcrumb Home anchor points there too;
//   * package caches, build output and VCS internals are flagged hidden, so
//     the dialog shows them only behind "Show hidden files";
//   * configured places (any absolute path, including outside the landing
//     directory) appear as jump rows on the first level.
//
// It is mounted in place of `directory-picker-auto` together with the browse
// client surface — the pair the seam documents as its swap point. Everything
// else (breadcrumbs, "New folder", truncation, symlink and abort handling)
// stays the upstream implementation.
//
// NOTE: no `#private` fields or methods here. Cordis hands consumers a Proxy
// around the service instance, and a private-field read through that Proxy
// throws "Cannot read private member … from an object whose class did not
// declare it". Upstream classes use TypeScript `private`, which compiles to an
// ordinary property; the JavaScript equivalent is this underscore convention.
import { stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import { applyNoise, DEFAULT_NOISE, homeAnchorPath, landingPath, mergePlaces } from './policy.js'

const Place = z.object({
  name: z.string().required(),
  path: z.string().required(),
})

export default class WorkspaceDirectoryPicker extends BrowseDirectoryPicker {
  static Config = z.object({
    /** Complete-result bound of one listing level (upstream field). */
    maxEntries: z.natural().min(1).default(1000),
    /** Where an unqualified listing lands; empty means the process working directory. */
    defaultPath: z.string().default(''),
    /** Breadcrumb Home anchor; empty means the landing directory. */
    homeAnchor: z.string().default(''),
    /** Directory names flagged hidden so the dialog dims them by default. */
    noise: z.array(z.string()).default(DEFAULT_NOISE),
    /** Extra jump rows on the first level: absolute paths, skipped when absent. */
    places: z.array(Place).default([]),
  })

  constructor(ctx, config) {
    super(ctx, config)
    this._config = config
    this._capability = undefined
  }

  /** The seam requires one stable capability object per service life. */
  capability() {
    const base = super.capability()
    this._capability ??= {
      kind: 'browse',
      list: (path, signal) => this._listLevel(base, path, signal),
      createDirectory: (path, name) => base.createDirectory(path, name),
    }
    return this._capability
  }

  async _listLevel(base, path, signal) {
    const config = this._config
    const landing = landingPath(path, config.defaultPath, process.cwd())
    let listing
    let anchor = homeAnchorPath(config.homeAnchor, config.defaultPath, process.cwd())
    try {
      listing = await base.list(landing, signal)
    } catch (error) {
      // A misconfigured or vanished landing directory must not cost the
      // operator the dialog: fall back to the upstream default (home), and
      // let the backend's own anchor stand with it.
      if (path !== undefined || landing === undefined) throw error
      this.ctx.logger?.warn?.(`workspace-picker: cannot open "${landing}", falling back to the home directory`)
      listing = await base.list(undefined, signal)
      anchor = undefined
    }
    const entries = listing.entries.map((entry) => applyNoise(entry, config.noise))
    const places = path === undefined ? await this._existingPlaces() : []
    return {
      ...listing,
      home: anchor ?? listing.home,
      entries: mergePlaces(entries, places, listing.path),
    }
  }

  /** Configured places that are directories right now; the rest are skipped silently. */
  async _existingPlaces() {
    const checked = await Promise.all(this._config.places.map(async (place) => {
      try {
        return (await stat(place.path)).isDirectory() ? place : undefined
      } catch {
        return undefined
      }
    }))
    return checked.filter((place) => place !== undefined)
  }
}
