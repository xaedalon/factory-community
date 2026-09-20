<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useTasks } from '../stores/tasks.js'
import { useProjects } from '../stores/projects.js'
import { initials, toneVariable } from '../identity.js'
import PageHeader from '../components/PageHeader.vue'
import TaskStateBadge from '../components/TaskStateBadge.vue'

/**
 * Which tasks are holding an environment.
 *
 * Read off the `hasEnvironment` flag rather than a table of its own. A flag is
 * already the honest record: `environment-create` earns it when it completes
 * and `environment-delete` clears it, so nothing here can drift from what
 * actually ran. A second store of the same fact could — and the one that went
 * stale would be this one.
 *
 * What Factory cannot show is what the environment *is*. It did not build it;
 * a workflow the project wrote did. Saying "this task has one, here is the run
 * that made it" is the whole truth available, so it is all this claims.
 */
const FLAG = 'hasEnvironment'

const tasks = useTasks()
const chosen = useProjects()
const { items } = storeToRefs(tasks)
const { items: projects } = storeToRefs(chosen)

onMounted(() => {
  void tasks.load()
  tasks.connect()
})
onUnmounted(() => tasks.disconnect())

const holding = computed(() => items.value.filter((task) => task.flags.includes(FLAG)))

/** Grouped by project, and only the projects that asked for environments. */
const groups = computed(() =>
  projects.value
    .filter((project) => project.usesEnvironments)
    .filter((project) => chosen.projectId === undefined || project.id === chosen.projectId)
    .map((project) => ({
      project,
      tasks: holding.value.filter((task) => task.projectId === project.id),
    })),
)

/**
 * Tasks holding an environment in a project that says it has none.
 *
 * A real state, not a defensive branch: turning the setting off does not reach
 * into tasks that already have one, and an environment nobody is tracking is
 * exactly the thing worth showing.
 */
const stray = computed(() =>
  holding.value.filter(
    (task) =>
      !projects.value.some((project) => project.id === task.projectId && project.usesEnvironments),
  ),
)

const acting = ref<string | undefined>(undefined)

/** Queue the project's own teardown workflow. Factory does not remove it itself. */
async function teardown(taskId: string): Promise<void> {
  acting.value = taskId
  try {
    await tasks.assign(taskId, [{ workflow: 'environment-delete', enabled: true }])
    await tasks.act(taskId, 'queue')
  } finally {
    acting.value = undefined
  }
}
</script>

<template>
  <PageHeader
    title="Environments"
    subtitle="Tasks holding an environment their project built for them."
  />

  <div class="px-8 py-6">
    <p
      v-if="groups.length === 0 && stray.length === 0"
      class="text-sm text-[var(--color-ink-muted)]"
      data-testid="environments-empty"
    >
      No project uses environments yet. Turn them on for a project and Factory copies in the
      <code class="value">environment-create</code>, <code class="value">environment-update</code> and
      <code class="value">environment-delete</code> workflows for you to write.
      <RouterLink to="/projects" class="text-[var(--color-accent-text)] hover:underline">
        Projects
      </RouterLink>
    </p>

    <section
      v-for="group in groups"
      :key="group.project.id"
      class="mb-6"
      :data-testid="`environments-${group.project.name}`"
    >
      <header class="mb-2 flex items-center gap-2">
        <span
          class="flex h-6 w-6 items-center justify-center rounded text-[10px] font-medium text-white"
          :style="{ backgroundColor: toneVariable(group.project.name) }"
          aria-hidden="true"
        >
          {{ initials(group.project.name) }}
        </span>
        <h2 class="text-sm">{{ group.project.name }}</h2>
      </header>

      <p
        v-if="group.tasks.length === 0"
        class="text-xs text-[var(--color-ink-faint)]"
        :data-testid="`environments-none-${group.project.name}`"
      >
        Nothing is holding an environment here.
      </p>

      <ul
        v-else
        class="divide-y divide-[var(--color-line)]/60 rounded-lg border border-[var(--color-line)]"
      >
        <li
          v-for="task in group.tasks"
          :key="task.id"
          class="flex items-center gap-4 px-4 py-3"
          :data-testid="`environment-${task.name}`"
        >
          <RouterLink
            :to="`/tasks/${task.id}`"
            class="min-w-0 flex-1 truncate text-sm hover:underline"
          >
            {{ task.name }}
          </RouterLink>
          <TaskStateBadge :state="task.state" />
          <button
            type="button"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
            :data-testid="`teardown-${task.name}`"
            :disabled="acting === task.id"
            @click="teardown(task.id)"
          >
            Tear down
          </button>
        </li>
      </ul>
    </section>

    <section v-if="stray.length > 0" data-testid="stray-environments">
      <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-warn)] uppercase">
        Holding an environment, in a project that says it has none
      </h2>
      <ul class="divide-y divide-[var(--color-line)]/60 rounded-lg border border-[var(--color-warn)]/40">
        <li
          v-for="task in stray"
          :key="task.id"
          class="flex items-center gap-4 px-4 py-3"
          :data-testid="`environment-${task.name}`"
        >
          <RouterLink
            :to="`/tasks/${task.id}`"
            class="min-w-0 flex-1 truncate text-sm hover:underline"
          >
            {{ task.name }}
          </RouterLink>
          <TaskStateBadge :state="task.state" />
          <button
            type="button"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
            :data-testid="`teardown-${task.name}`"
            :disabled="acting === task.id"
            @click="teardown(task.id)"
          >
            Tear down
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
