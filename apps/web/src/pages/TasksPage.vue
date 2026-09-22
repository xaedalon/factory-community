<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useTasks } from '../stores/tasks.js'
import { useProjects } from '../stores/projects.js'
import PageHeader from '../components/PageHeader.vue'
import TaskStateBadge from '../components/TaskStateBadge.vue'
import TaskActions from '../components/TaskActions.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
import { toneFor } from '../states.js'
import type { TaskListItem, TaskState } from '../api/client.js'

/**
 * The board.
 *
 * Two views of one list: a table for reading many at once, and columns by state
 * for seeing where the work is piled up. Both render from the same store, so
 * neither can be showing something the other is not.
 *
 * Rows carry the actions the daemon offered rather than a fixed set of buttons.
 */
const store = useTasks()
const projects = useProjects()
const { visible, summary, loading, error, filters, view, acting, batching, batch, workflows } =
  storeToRefs(store)

/**
 * What the last whole-project action did, in one sentence.
 *
 * A batch can legitimately do nothing — every draft in the project may have an
 * empty plan — and the first time Queue all was used against a real project it
 * did exactly that, silently: the daemon said which four tasks it had left and
 * why, and this page threw the answer away. A button that answers silence is a
 * button that looks broken.
 */
const batchSummary = computed(() => {
  const report = batch.value
  if (report === undefined) return undefined
  const noun = report.count === 1 ? 'task' : 'tasks'
  if (report.count > 0) {
    return report.action === 'queued'
      ? `Queued ${report.count} ${noun}.`
      : `Stopped ${report.count} ${noun}.`
  }
  return report.action === 'queued' ? 'Nothing was queued.' : 'Nothing was running.'
})

/**
 * The header says which board this is.
 *
 * It said "Tasks" whatever was chosen, and the only sign of the selection was a
 * ring on a 40px square in the rail. The whole-project buttons make that worse:
 * "Stop all" has to say all of *what*.
 */
const chosenProject = computed(() => projects.current?.name)

/**
 * Two clicks to stop everything, one to queue it.
 *
 * The same idiom the definition editor uses for delete, for the same reason:
 * stopping kills agents mid-sentence and there is no undo, while queueing is
 * undone by stopping.
 */
const confirmingStop = ref(false)
const stopAll = async (): Promise<void> => {
  confirmingStop.value = false
  await store.stopProject()
}

const COLUMNS: TaskState[] = ['draft', 'queued', 'running', 'awaiting_approval', 'blocked', 'done']
const HEADINGS: Record<string, string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  blocked: 'Blocked',
  done: 'Done',
}
const STATES: (TaskState | 'all')[] = [
  'all',
  'draft',
  'queued',
  'running',
  'awaiting_approval',
  'blocked',
  'done',
  'cancelled',
]

const inColumn = (state: TaskState) => visible.value.filter((task) => task.state === state)
/** The names of the blockers that have not happened yet. */
const waitingFor = (task: TaskListItem): string[] =>
  task.blockers.filter((blocker) => blocker.status === 'waiting').map((blocker) => blocker.name)
const percent = (task: { progress?: { completed: number; total: number } }): number =>
  task.progress === undefined || task.progress.total === 0
    ? 0
    : Math.round((task.progress.completed / task.progress.total) * 100)

const ago = (iso: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

onMounted(() => {
  void store.load()
  // Live from here on: a run started by the scheduler changes this page with
  // nobody touching it, which is most of what a board is for.
  store.connect()
})
onUnmounted(() => store.disconnect())
</script>

<template>
  <PageHeader
    :title="chosenProject === undefined ? 'Tasks' : `Tasks · ${chosenProject}`"
    subtitle="Everything queued, running, waiting and finished."
  >
    <!-- Only with a project chosen: the graph belongs to a project, and
         queueing every task in every repository from one button is not
         something anybody means. -->
    <template v-if="chosenProject !== undefined" #actions>
      <AppButton
        label="Queue all"
        icon="play"
        tone="primary"
        :disabled="batching"
        hint="Queue every draft in this project; the graph decides what starts"
        data-testid="queue-all"
        @click="store.queueProject()"
      />
      <AppButton
        v-if="!confirmingStop"
        label="Stop all"
        icon="stop"
        tone="danger"
        :disabled="batching"
        hint="Halt this project's work — agents are killed mid-sentence"
        data-testid="stop-all"
        @click="confirmingStop = true"
      />
      <button
        v-else
        type="button"
        :disabled="batching"
        class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/60 px-3 py-1.5 text-sm text-[var(--color-danger)] disabled:opacity-40"
        data-testid="stop-all-confirm"
        @click="stopAll()"
      >
        <AppIcon name="stop" />
        Really stop everything?
      </button>
    </template>
  </PageHeader>

  <div class="page-body">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="summary">
      <div
        v-for="card in [
          { key: 'total', label: 'Total tasks', value: summary.total, tone: 'text-[var(--color-ink)]' },
          { key: 'running', label: 'Running', value: summary.running, tone: 'text-[var(--color-info)]' },
          { key: 'waiting', label: 'Awaiting approval', value: summary.waiting, tone: 'text-[var(--color-warn)]' },
          { key: 'blocked', label: 'Blocked', value: summary.blocked, tone: 'text-[var(--color-danger)]' },
        ]"
        :key="card.key"
        :data-testid="`summary-${card.key}`"
        class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3"
      >
        <p class="font-mono text-metric" :class="card.tone">{{ card.value }}</p>
        <p class="mt-0.5 text-xs text-[var(--color-ink-muted)]">{{ card.label }}</p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <!-- The icon is what makes this box recognisable as search before the
           placeholder is read, which is the whole job of a search box. -->
      <div class="relative">
        <AppIcon
          name="search"
          class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--color-ink-faint)]"
        />
        <input
          v-model="filters.query"
          type="search"
          data-testid="search"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          class="w-56 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] py-1.5 pr-2.5 pl-8 text-sm placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>
      <!-- `.field-control` in a fixed-width box rather than on a bare select.
           The class sets `width: 100%`, and it is declared after Tailwind's
           utilities in `tokens.css`, so a `w-40` on the select itself would
           lose the cascade and stretch across the row. The wrapper is what
           `width: 100%` resolves against. -->
      <div class="w-40">
        <select v-model="filters.state" data-testid="filter-state" class="field-control text-sm">
          <option v-for="state in STATES" :key="state" :value="state">
            {{ state === 'all' ? 'All statuses' : HEADINGS[state] ?? state }}
          </option>
        </select>
      </div>
      <div class="w-44">
        <select
          v-model="filters.workflow"
          data-testid="filter-workflow"
          class="field-control text-sm"
        >
          <option value="all">All workflows</option>
          <option v-for="workflow in workflows" :key="workflow" :value="workflow">
            {{ workflow }}
          </option>
        </select>
      </div>

      <div class="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-line-strong)] p-0.5">
        <button
          v-for="option in ['list', 'board'] as const"
          :key="option"
          type="button"
          :data-testid="`view-${option}`"
          class="rounded px-2.5 py-1 text-xs capitalize transition-colors"
          :class="
            view === option
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-muted)]'
          "
          @click="view = option"
        >
          {{ option }}
        </button>
      </div>
      <Tooltip label="A piece of work, and the workflows that will do it">
        <RouterLink
          to="/tasks/new"
          data-testid="new-task"
          class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent)]/85"
        >
          <AppIcon name="add" />
          New task
        </RouterLink>
      </Tooltip>
    </div>

    <p
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </p>

    <!-- Says what a whole-project action did, including when it did nothing.
         Dismissible rather than timed: it lists task names, and a message
         somebody is reading must not vanish while they read it. -->
    <div
      v-if="batchSummary"
      class="flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-3 text-sm"
      data-testid="batch-report"
    >
      <div class="min-w-0 flex-1">
        <p>{{ batchSummary }}</p>
        <p
          v-if="batch && batch.skipped.length > 0"
          class="mt-1 text-xs text-[var(--color-ink-muted)]"
          data-testid="batch-skipped"
        >
          <!-- The names, not just the count: "4 were skipped" sends somebody
               hunting through the board for which four. -->
          Left alone —
          {{ batch.skipped.map((entry) => `${entry.name} (${entry.reason})`).join(', ') }}
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        data-testid="dismiss-batch-report"
        @click="store.dismissBatch()"
      >
        Dismiss
      </button>
    </div>

    <p v-if="loading && visible.length === 0" class="text-sm text-[var(--color-ink-muted)]" data-testid="loading">
      Loading…
    </p>

    <p
      v-else-if="visible.length === 0"
      class="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-10 text-center text-sm text-[var(--color-ink-muted)]"
      data-testid="tasks-empty"
    >
      Nothing here yet. A task is a piece of work and the workflows that will do it.
    </p>

    <!-- List: the default, because most questions are answered by reading down
         a column rather than by looking at where things sit. -->
    <!-- Scrolls sideways rather than hiding the right-hand columns. Eight
         columns need about a thousand pixels, and `main` clips rather than
         scrolls, so under a window of roughly 1270 the status, progress and
         actions were simply unreachable — no scrollbar, no hint they existed. -->
    <div v-else-if="view === 'list'" class="min-w-0 overflow-x-auto">
      <table class="w-full min-w-[56rem] text-sm" data-testid="task-table">
        <thead>
          <tr class="border-b border-[var(--color-line)] text-left font-mono text-label text-[var(--color-ink-faint)] uppercase">
            <th class="py-2 pr-4">Ticket</th>
            <th class="py-2 pr-4">Task</th>
            <th class="py-2 pr-4">Project</th>
            <th class="py-2 pr-4">Workflow</th>
            <th class="py-2 pr-4">Status</th>
            <th class="py-2 pr-4">Progress</th>
            <th class="py-2 pr-4">Updated</th>
            <th class="py-2" />
          </tr>
        </thead>
        <tbody>
          <!-- A row lights up under the pointer. On these surfaces a border is
               the only thing separating one row from the next, and 2% of white
               is what tells you which one you are about to open. -->
          <tr
            v-for="task in visible"
            :key="task.id"
            class="border-b border-[var(--color-line)] transition-colors hover:bg-[var(--color-veil-weak)]"
            :data-testid="`task-row-${task.name}`"
          >
            <!-- One identifier, on one line. Auto table layout was breaking
                 "LDG-104" at the hyphen and stacking it, which makes a column
                 of tickets unreadable and every row taller than it needs. -->
            <td class="py-3 pr-4 font-mono text-xs whitespace-nowrap text-[var(--color-ink-muted)]">
              {{ task.ticketId ?? '—' }}
            </td>
            <td class="py-3 pr-4">
              <RouterLink
                :to="`/tasks/${task.id}`"
                class="hover:text-[var(--color-accent-text)]"
                :data-testid="`open-${task.name}`"
              >
                {{ task.name }}
              </RouterLink>
              <!-- One line, with the whole of it on hover and on the task's own
                   page. A failing step's reason is the command it ran, which for
                   a real agent invocation is several hundred characters: left to
                   wrap it made one row four times the height of its neighbours
                   and pushed the rest of the board off the screen. -->
              <!-- `line-clamp-1`, not `truncate`. Both show one line, but
                   truncate does it with `white-space: nowrap`, and an auto-layout
                   table sizes a column to its widest content: a failing step's
                   reason is the command it ran, so the column asked for all
                   several hundred characters of it and took the table 400px past
                   the pane. Clamping wraps and then hides, so it costs the
                   column nothing. The whole of it is in the tooltip and on the
                   task's own page. -->
              <p
                v-if="task.blockedReason"
                class="mt-0.5 line-clamp-1 text-xs text-[var(--color-danger)]"
                :title="task.blockedReason"
              >
                {{ task.blockedReason }}
              </p>
              <!-- What it is still waiting for, in the same muted-subtitle idiom
                   the blocked reason uses. Only the blockers that have not
                   happened: a row listing what is already done would grow a line
                   that never goes away. -->
              <p
                v-if="waitingFor(task).length > 0"
                class="mt-0.5 text-xs text-[var(--color-ink-faint)]"
                :data-testid="`waiting-${task.name}`"
              >
                waiting for {{ waitingFor(task).join(', ') }}
              </p>
            </td>
            <td class="py-3 pr-4 font-mono text-xs text-[var(--color-ink-muted)]">
              {{ store.projectName(task) ?? '—' }}
            </td>
            <td class="py-3 pr-4 font-mono text-xs text-[var(--color-ink-muted)]">
              {{ store.currentWorkflow(task) ?? '—' }}
            </td>
            <td class="py-3 pr-4"><TaskStateBadge :state="task.state" /></td>
            <td class="py-3 pr-4">
              <!-- Drawn in the state's own colour rather than the accent. A
                   blocked task and a finished one had identical purple bars, on
                   a board where colour means status everywhere else. -->
              <div v-if="task.progress" class="flex items-center gap-2">
                <span class="h-1 w-24 overflow-hidden rounded-full bg-[var(--color-track)]">
                  <span
                    class="block h-full transition-[width]"
                    :style="{ width: `${percent(task)}%`, background: toneFor(task.state) }"
                  />
                </span>
                <span
                  class="font-mono text-meta text-[var(--color-ink-muted)]"
                  :data-testid="`progress-${task.name}`"
                >
                  {{ task.progress.completed }}/{{ task.progress.total }} phases
                </span>
              </div>
              <span v-else class="text-xs text-[var(--color-ink-faint)]">—</span>
            </td>
            <td class="py-3 pr-4 text-xs text-[var(--color-ink-muted)]">{{ ago(task.updatedAt) }}</td>
            <td class="py-3">
              <TaskActions
                :actions="task.actions"
                :busy="acting === task.id"
                :only="['queue', 'retry', 'approve', 'reject', 'cancel']"
                @act="(action) => store.act(task.id, action)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Board: the same tasks, arranged by where they are stuck. -->
    <div v-else class="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="task-board">
      <section
        v-for="column in COLUMNS"
        :key="column"
        class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2"
        :data-testid="`column-${column}`"
      >
        <header class="flex items-center justify-between px-1 pb-2">
          <span class="font-mono text-label text-[var(--color-ink-faint)] uppercase">
            {{ HEADINGS[column] }}
          </span>
          <span class="font-mono text-meta text-[var(--color-ink-faint)]">
            {{ inColumn(column).length }}
          </span>
        </header>
        <RouterLink
          v-for="task in inColumn(column)"
          :key="task.id"
          :to="`/tasks/${task.id}`"
          class="mb-1.5 block rounded-md border border-[var(--color-line)] bg-[var(--color-raised)] p-2.5 hover:border-[var(--color-line-strong)]"
          :data-testid="`card-${task.name}`"
        >
          <p class="text-xs">{{ task.name }}</p>
          <p class="mt-1 font-mono text-meta text-[var(--color-ink-faint)]">
            {{ store.currentWorkflow(task) ?? 'no workflow' }}
          </p>
          <!-- The interface reference ends every card with "0/7 phases  0%".
               The bar is the same one the table draws, because without it a
               card at 0% is a grey separator and two numbers nobody reads:
               the count says how far along, the bar says how far there is to
               go, and only one of those is visible at a glance. Full width
               here rather than the table's fixed 24, since a column is
               narrow. -->
          <div
            v-if="task.progress"
            class="mt-2 border-t border-[var(--color-line)] pt-1.5"
            :data-testid="`card-progress-${task.name}`"
          >
            <span class="block h-1 overflow-hidden rounded-full bg-[var(--color-track)]">
              <span
                class="block h-full transition-[width]"
                :style="{ width: `${percent(task)}%`, background: toneFor(task.state) }"
                :data-testid="`card-progress-fill-${task.name}`"
              />
            </span>
            <div class="mt-1 flex items-center justify-between">
              <span class="font-mono text-meta text-[var(--color-ink-muted)]">
                {{ task.progress.completed }}/{{ task.progress.total }} phases
              </span>
              <span class="font-mono text-meta text-[var(--color-ink-muted)]">
                {{ percent(task) }}%
              </span>
            </div>
          </div>
        </RouterLink>
      </section>
    </div>
  </div>
</template>
