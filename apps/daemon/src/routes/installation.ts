import type { FastifyInstance } from 'fastify'
import { MAX_UI_SCALE, UI_THEMES, isUiTheme } from '@factory/config'
import {
  DISCLAIMER,
  DISCLAIMER_VERSION,
  EXECUTION_PROFILES,
  hasAccepted,
  isExecutionProfile,
} from '@factory/core'
import type { Runtime } from '@factory/runtime'

/**
 * What is installed, and what the person using it has chosen.
 *
 * `GET /api/capabilities` used to serve the first half grouped by *kind*,
 * which was the right shape when the builder was its only reader — the step
 * kinds and the providers, and those are served better by
 * `/api/registries/*`. It could not show a plugin that was switched off or one
 * that failed to load, because it read the host, and the host only knows what
 * loaded. So this reads the *catalogue* instead, which is a superset.
 */
export function registerInstallationRoutes(app: FastifyInstance, runtime: Runtime): void {
  /**
   * Every plugin Factory knows about, with what each contributed.
   *
   * `restartRequired` is `enabled === false && loaded === true`: the host has
   * no unload, so a plugin switched off while the daemon runs keeps
   * contributing until the next start. The board says so rather than letting
   * somebody discover it.
   */
  app.get('/api/plugins', async () => ({
    plugins: runtime.plugins.map((candidate) => ({
      ...candidate,
      restartRequired: !candidate.enabled && candidate.loaded,
      // Only knowable for a plugin that loaded. A disabled one contributes
      // nothing, and saying what it *would* contribute would mean importing
      // it, which is the one thing switching it off forbids.
      provides: candidate.loaded
        ? runtime.host
            .kinds()
            .flatMap((kind) =>
              runtime.host
                .list(kind)
                .filter((entry) => entry.plugin === candidate.name)
                .map((entry) => ({
                  kind,
                  id: entry.capability.id,
                  summary: entry.capability.summary,
                })),
            )
        : [],
    })),
  }))

  /**
   * Switch one on or off.
   *
   * Its own route rather than a key in `PATCH /api/settings`, because two
   * things have to happen that a generic patch cannot do: check the id against
   * the catalogue, so a typo is a refusal rather than a line silently written
   * into somebody's settings file, and refuse an essential plugin with a
   * reason.
   *
   * Enabling never 404s. Removing an id nothing claims is exactly how a stale
   * one gets forgotten, so refusing it would trap the person who needs it.
   */
  app.post<{ Params: { id: string }; Body: { enabled?: unknown } }>(
    '/api/plugins/:id',
    async (request, reply) => {
      const wanted = request.body?.enabled
      if (typeof wanted !== 'boolean') {
        return reply.code(400).send({ error: 'enabled is true or false.' })
      }

      const id = decodeURIComponent(request.params.id)
      const known = runtime.plugins.find((candidate) => candidate.id === id)
      if (!wanted && known === undefined) {
        return reply.code(404).send({ error: `No plugin "${id}".` })
      }
      if (!wanted && known?.essential === true) {
        return reply.code(409).send({
          error:
            `"${id}" is what makes workflows parse and run. Switching it off would leave ` +
            `Factory unable to do anything.`,
          essential: true,
        })
      }

      const disabled = new Set(runtime.settings.current().plugins.disabled)
      if (wanted) disabled.delete(id)
      else disabled.add(id)

      const saved = runtime.settings.update({ plugins: { disabled: [...disabled] } })
      if (saved.problems.length > 0) {
        return reply.code(500).send({ error: saved.problems[0]?.message, problems: saved.problems })
      }

      // The catalogue is this process's, so it is updated to match rather than
      // rebuilt: rebuilding would mean re-reading config and re-importing, and
      // the one thing that cannot change without a restart is what is loaded.
      const after = runtime.plugins.map((candidate) =>
        candidate.id === id ? { ...candidate, enabled: wanted } : candidate,
      )
      runtime.replacePlugins(after)

      const entry = after.find((candidate) => candidate.id === id)
      return {
        plugin: entry ?? { id, source: 'unknown', essential: false, enabled: wanted, loaded: false },
        restartRequired: !wanted && entry?.loaded === true,
      }
    },
  )

  app.get('/api/settings', async () => ({
    settings: runtime.settings.current(),
    file: runtime.settings.file,
    problems: runtime.settings.problems,
    /**
     * Served with the settings rather than on a route of its own.
     *
     * The board needs both together to decide anything: whether to show the
     * first-run panel is `accepted`, and what to put in it is `disclaimer`. Two
     * routes would mean two requests that can disagree for a moment, and the
     * moment they disagree is the one where somebody starts a run.
     */
    disclaimer: DISCLAIMER,
    accepted: hasAccepted(runtime.settings.current().security.acceptedVersion),
  }))

  /**
   * Record that somebody has read what an agent run can reach.
   *
   * Its own route rather than a key in `PATCH /api/settings`, for the reason
   * `POST /api/plugins/:id` has one: the version stored is **Factory's**, not
   * the client's. A client that could send the number could accept a disclaimer
   * it had not been shown — including a future one — which is the only thing
   * this record is for.
   */
  app.post('/api/settings/accept', async (_request, reply) => {
    const saved = runtime.settings.update({
      security: { acceptedVersion: DISCLAIMER_VERSION },
    })
    if (saved.problems.length > 0) {
      return reply.code(500).send({ error: saved.problems[0]?.message, problems: saved.problems })
    }
    return { settings: saved.settings, accepted: true, version: DISCLAIMER_VERSION }
  })

  /**
   * Change a preference.
   *
   * Only `ui` here: the disabled list has a route of its own, above. Bounds
   * are checked before the file is touched so a refusal reads as a refusal
   * rather than as a save that quietly did nothing.
   */
  app.patch<{
    Body: { ui?: { scale?: unknown; theme?: unknown }; security?: { profile?: unknown } }
  }>('/api/settings', async (request, reply) => {
    const scale = request.body?.ui?.scale
    const theme = request.body?.ui?.theme
    const profile = request.body?.security?.profile
    if (scale === undefined && theme === undefined && profile === undefined) {
      return reply
        .code(400)
        .send({ error: 'Send { ui: { scale } }, { ui: { theme } }, or { security: { profile } }.' })
    }
    if (scale !== undefined) {
      if (typeof scale !== 'number' || !Number.isFinite(scale)) {
        return reply.code(400).send({ error: 'scale is a number.' })
      }
      if (scale < 1 || scale > MAX_UI_SCALE) {
        return reply
          .code(400)
          .send({ error: `scale is between 1 and ${MAX_UI_SCALE}.` })
      }
    }
    if (theme !== undefined && !isUiTheme(theme)) {
      return reply.code(400).send({ error: `theme is one of ${UI_THEMES.join(', ')}.` })
    }
    if (profile !== undefined && !isExecutionProfile(profile)) {
      return reply
        .code(400)
        .send({ error: `profile is one of ${EXECUTION_PROFILES.join(', ')}.` })
    }

    // One update, so a patch carrying all three cannot half-apply — and so the
    // read-back through the schema happens once.
    const saved = runtime.settings.update({
      ...(scale === undefined && theme === undefined
        ? {}
        : {
            ui: {
              ...(scale === undefined ? {} : { scale }),
              ...(theme === undefined ? {} : { theme }),
            },
          }),
      ...(profile === undefined ? {} : { security: { profile } }),
    })
    if (saved.problems.length > 0) {
      return reply.code(500).send({ error: saved.problems[0]?.message, problems: saved.problems })
    }
    return { settings: saved.settings, file: runtime.settings.file }
  })
}
