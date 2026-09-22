<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import Tooltip from './Tooltip.vue'
import { computed, ref, watch } from 'vue'
import { api, type DefinitionListing, type WorkflowChoice } from '../api/client.js'
import ScopeBadge from './ScopeBadge.vue'

/**
 * The workflows a task will run, in order.
 *
 * The order is the whole point: the engine runs them top to bottom, and
 * `worktree-create` before `development` is a different task from the other way
 * round. The form this replaces used toggle buttons, where the order was
 * whatever order you happened to click in and nothing on screen said so — which
 * made the one thing that decides what happens the one thing that was invisible.
 *
 * So: numbered rows, and the same reorder-and-remove idiom the phase editor
 * uses, because a
 * person who has ordered phases in a workflow already knows how to do this.
 * Duplicates are allowed, unlike phases — running tests, fixing, then running
 * tests again is a real plan, not a mistake.
 */
const props = defineProps<{
  /** What this project can run. */
  available: DefinitionListing[]
  modelValue: WorkflowChoice[]
  /** False once the task is carrying the plan out; the daemon refuses then too. */
  editable: boolean
  /** Whose workflows these are, so the chain resolves in the right scope. */
  project?: string | undefined
  /**
   * Whether the tickboxes may be changed, which outlives `editable`.
   *
   * Calling off a later stage while an earlier one runs is a reasonable thing
   * to want; adding, removing and reordering under a running engine is not.
   * Defaults to `editable` so a caller that does not care gets today's rule.
   */
  tickable?: boolean | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: WorkflowChoice[]] }>()

/**
 * What may actually be added, which is not everything that exists.
 *
 * A workflow gated on a facility the project has switched off can never run —
 * it would sit in the queue waiting for a flag nothing provides. Offering it is
 * offering a task that cannot start, so it is left out of the picker; the
 * Workflows page still lists it, marked, because the file is real.
 *
 * One already in `modelValue` is still rendered: a plan made before the setting
 * was turned off should be visible and removable, not silently invisible.
 */
const offerable = computed(() => props.available.filter((entry) => entry.unavailable === undefined))

/**
 * The value written but not yet handed back as a prop.
 *
 * Every operation reads the list before changing it, and a prop only catches up
 * on the next render — so two changes in the same tick both start from the same
 * array and the second silently discards the first. Holding what was just
 * written, until the prop agrees with it, makes them compose. (`defineModel`
 * does not help here: with a `v-model` bound it reads straight through to the
 * prop.)
 */
const pending = ref<WorkflowChoice[] | undefined>(undefined)
const chosen = computed(() => pending.value ?? props.modelValue)
watch(
  () => props.modelValue,
  () => {
    pending.value = undefined
  },
)

const write = (next: WorkflowChoice[]): void => {
  pending.value = next
  emit('update:modelValue', next)
}

const known = computed(() => new Map(props.available.map((item) => [item.name, item])))
const tickable = computed(() => props.tickable ?? props.editable)

/** What the last add pulled in, so five new rows are an explanation not a surprise. */
const pulledIn = ref<string[]>([])
/** Only the newest resolution may write, so a fast second click cannot lose to a slow first. */
let asked = 0

/**
 * Add a workflow, and whatever it needs.
 *
 * `verify` reads artifacts that four earlier workflows write, so adding it
 * alone gets you a task whose prompt points at files nothing produced.
 *
 * The name lands immediately and the chain fills in when the daemon answers.
 * That order matters: writing synchronously first is what keeps `pending`
 * correct, so a second click reads a list that already contains the first —
 * awaiting before writing would reintroduce exactly the lost-click bug the
 * buffer above exists to prevent.
 */
async function append(name: string): Promise<void> {
  write([...chosen.value, { workflow: name, enabled: true }])
  const mine = (asked += 1)
  const names = () => chosen.value.map((entry) => entry.workflow)
  try {
    const resolved = await api.resolveNeeds(names(), props.project)
    if (mine !== asked) return
    pulledIn.value = resolved.added
    if (resolved.order.join('\u0000') === names().join('\u0000')) return
    // Rebuilt by name, taking each existing entry once so a reorder keeps the
    // ids — matching on position here would hand the daemon a list whose
    // entries have swapped identities.
    const spare = [...chosen.value]
    write(
      resolved.order.map((workflow) => {
        const at = spare.findIndex((entry) => entry.workflow === workflow)
        return at === -1 ? { workflow, enabled: true } : (spare.splice(at, 1)[0] as WorkflowChoice)
      }),
    )
  } catch {
    // The name is already in the list; it just has no company. Doctor reports
    // an incomplete list, so failing quietly here loses nothing.
  }
}

/**
 * Tick or untick one entry.
 *
 * Through `write` like everything else, so it composes with an add or a move in
 * the same tick — which is the whole reason the buffer above exists.
 */
const toggle = (index: number): void =>
  write(
    chosen.value.map((entry, position) =>
      position === index ? { ...entry, enabled: !entry.enabled } : entry,
    ),
  )
const remove = (index: number): void => {
  pulledIn.value = []
  write(chosen.value.filter((_, position) => position !== index))
}
function move(index: number, delta: number): void {
  const next = [...chosen.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved as WorkflowChoice)
  write(next)
}
</script>

<template>
  <div data-testid="workflow-picker">
    <ol v-if="chosen.length > 0" class="space-y-1.5" data-testid="chosen-workflows">
      <li
        v-for="(entry, index) in chosen"
        :key="entry.id ?? `${entry.workflow}-${index}`"
        class="flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-1.5"
        :class="entry.enabled ? '' : 'opacity-60'"
        :data-testid="`task-workflow-${entry.workflow}`"
      >
        <!-- Always rendered, disabled rather than hidden when the list is
             locked: which of these are still to come is the most useful thing
             on a running task's page, and hiding it would leave the row saying
             nothing at all. -->
        <input
          type="checkbox"
          :checked="entry.enabled"
          :disabled="!tickable"
          class="h-3.5 w-3.5 accent-[var(--color-accent)]"
          :data-testid="`workflow-${index}-enabled`"
          :title="entry.enabled ? 'Still to run' : 'Not going to run'"
          @change="toggle(index)"
        />
        <span class="font-mono text-meta text-[var(--color-ink-faint)]">{{ index + 1 }}</span>
        <span class="value flex-1" :data-testid="`workflow-${index}-name`">{{ entry.workflow }}</span>

        <!-- Unticked-because-it-ran and unticked-because-I-unticked-it look
             identical without this, and telling them apart is the whole point
             of the feature. -->
        <span
          v-if="entry.ran"
          class="font-mono text-meta text-[var(--color-ink-faint)]"
          :data-testid="`workflow-${index}-ran`"
          title="It has run, so it cannot be taken off the list"
        >
          ran
        </span>

        <ScopeBadge v-if="known.get(entry.workflow)" :scope="known.get(entry.workflow)!.winner.scope" />
        <!-- A name nothing resolves will fail at plan time, which is a long way
             from here. Saying so now costs a span. -->
        <span
          v-else-if="available.length > 0"
          class="font-mono text-meta text-[var(--color-danger)]"
          :data-testid="`workflow-${index}-missing`"
        >
          no such workflow
        </span>

        <template v-if="editable">
          <Tooltip :label="index === 0 ? 'Already first' : 'Run this workflow earlier'">
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
              :aria-label="`Move ${entry.workflow} earlier`"
              :disabled="index === 0"
              :data-testid="`workflow-${index}-up`"
              @click="move(index, -1)"
            >
              <AppIcon name="up" :size="13" />
            </button>
          </Tooltip>
          <Tooltip
            :label="index === modelValue.length - 1 ? 'Already last' : 'Run this workflow later'"
          >
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
              :aria-label="`Move ${entry.workflow} later`"
              :disabled="index === modelValue.length - 1"
              :data-testid="`workflow-${index}-down`"
              @click="move(index, 1)"
            >
              <AppIcon name="down" :size="13" />
            </button>
          </Tooltip>
          <!-- Gone once it has run: the daemon refuses the removal, and a
               button whose only outcome is a refusal is a worse way to learn
               that than not having the button. -->
          <Tooltip v-if="!entry.ran" :label="`Take ${entry.workflow} out of this task`">
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-danger)]"
              :aria-label="`Remove ${entry.workflow}`"
              :data-testid="`workflow-${index}-remove`"
              @click="remove(index)"
            >
              <AppIcon name="close" :size="13" />
            </button>
          </Tooltip>
        </template>
      </li>
    </ol>

    <p v-else class="text-xs text-[var(--color-ink-faint)]" data-testid="no-workflows-chosen">
      Nothing chosen yet. Workflows run top to bottom, and the first one starts when the task is
      queued.
    </p>

    <div v-if="editable" class="mt-3 flex flex-wrap gap-1.5" data-testid="available-workflows">
      <button
        v-for="workflow in offerable"
        :key="workflow.name"
        type="button"
        :data-testid="`pick-workflow-${workflow.name}`"
        class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 font-mono text-xs text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
        @click="append(workflow.name)"
      >
        + {{ workflow.name }}
      </button>
      <p
        v-if="pulledIn.length > 0"
        class="w-full text-xs text-[var(--color-ink-faint)]"
        data-testid="pulled-in"
      >
        Added {{ pulledIn.join(', ') }} — needed before what you picked.
      </p>
      <p v-if="offerable.length === 0" class="text-xs text-[var(--color-ink-faint)]">
        {{
          available.length === 0
            ? 'No workflows here yet — build one first.'
            : 'Nothing this project can run — the workflows here need worktrees or environments, which it has switched off.'
        }}
      </p>
    </div>
  </div>
</template>
