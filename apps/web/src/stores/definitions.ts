import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { ApiError, api, type DefinitionKind, type DefinitionListing } from '../api/client.js'

/**
 * Loading state shared by the list pages.
 *
 * Every page needs the same three things — the data, whether it is still
 * arriving, and what went wrong — so they are modelled once rather than
 * re-invented per page with slightly different names.
 */
export const useDefinitions = defineStore('definitions', () => {
  /**
   * One list per kind, keyed rather than a named ref each.
   *
   * Three named refs and an if/else chain is the shape that made adding a kind
   * a hunt through the file; a record is the same thing with the branching
   * removed.
   */
  const byKind = reactive<Record<DefinitionKind, DefinitionListing[]>>({
    workflow: [],
    phase: [],
    agent: [],
    profile: [],
  })
  const workflows = computed(() => byKind.workflow)
  const phases = computed(() => byKind.phase)
  const agents = computed(() => byKind.agent)
  const profiles = computed(() => byKind.profile)
  const loading = ref(false)
  const error = ref<string | undefined>(undefined)

  /**
   * What the chosen project can see.
   *
   * A definition's name is only meaningful inside a scope chain, and a project
   * has its own, so the list is asked for per project rather than filtered
   * afterwards — the browser has no way to know a repository defines a
   * `deploy` of its own.
   */
  async function load(kind: DefinitionKind, project?: string): Promise<void> {
    loading.value = true
    error.value = undefined
    try {
      byKind[kind] = (await api.list(kind, project)).items
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      loading.value = false
    }
  }

  return { byKind, workflows, phases, agents, profiles, loading, error, load }
})
