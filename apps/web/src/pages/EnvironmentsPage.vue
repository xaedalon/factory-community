<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useTasks } from '../stores/tasks.js'
import { useProjects } from '../stores/projects.js'
import { markInitials, markTone } from '../identity.js'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
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

/**
 * Two clicks, because the second one is somebody's environment.
 *
 * Tearing down runs the project's own `environment-delete`, and whatever that
 * workflow removes is gone. The same idiom the definition editor and the
 * project page use, for the same reason: no undo.
 */
const confirming = ref<string | undefined>(undefined)
const router = useRouter()
</script>

<template>
  <PageHeader
    title="Environments"
    subtitle="Tasks holding an environment their project built for them."
  />

  <div class="page-body">
    <div
      v-if="groups.length === 0 && stray.length === 0"
      class="rounded-xl border border-dashed border-[var(--color-line)] px-6 py-12 text-center"
      data-testid="environments-empty"
    >
      <AppIcon name="environment" :size="22" class="mx-auto text-[var(--color-ink-faint)]" />
      <p class="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-[var(--color-ink-muted)]">
        No project uses environments yet. Turn them on for a project and Factory copies in the
        <code class="value">environment-create</code>, <code class="value">environment-update</code>
        and <code class="value">environment-delete</code> workflows for you to write.
      </p>
      <div class="mt-4 flex justify-center">
        <AppButton
          label="Go to projects"
          icon="project"
          tone="primary"
          hint="Turn environments on for a project"
          @click="router.push('/projects')"
        />
      </div>
    </div>

    <section
      v-for="group in groups"
      :key="group.project.id"
      :data-testid="`environments-${group.project.name}`"
    >
      <header class="mb-2 flex items-center gap-2">
        <span
          class="flex h-6 w-6 items-center justify-center rounded text-[10px] font-medium text-white"
          :style="{ backgroundColor: markTone(group.project) }"
          aria-hidden="true"
        >
          {{ markInitials(group.project) }}
        </span>
        <h2 class="text-title">{{ group.project.name }}</h2>
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
        class="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]"
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
          <Tooltip
            v-if="confirming !== task.id"
            label="Run this project's environment-delete for this task"
          >
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-danger)]/60 hover:text-[var(--color-danger)] disabled:opacity-50"
              :data-testid="`teardown-${task.name}`"
              :disabled="acting === task.id"
              @click="confirming = task.id"
            >
              <AppIcon name="remove" :size="12" />
              Tear down
            </button>
          </Tooltip>
          <button
            v-else
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/60 px-2 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
            :data-testid="`teardown-confirm-${task.name}`"
            :disabled="acting === task.id"
            @click="confirming = undefined; teardown(task.id)"
          >
            <AppIcon name="remove" :size="12" />
            Really tear it down?
          </button>
        </li>
      </ul>
    </section>

    <section v-if="stray.length > 0" data-testid="stray-environments">
      <h2 class="mb-2 flex items-center gap-2 text-title text-[var(--color-warn)]">
        <AppIcon name="alert" :size="15" />
        Holding an environment, in a project that says it has none
      </h2>
      <ul class="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-warn)]/40">
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
          <Tooltip
            v-if="confirming !== task.id"
            label="Run this project's environment-delete for this task"
          >
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-danger)]/60 hover:text-[var(--color-danger)] disabled:opacity-50"
              :data-testid="`teardown-${task.name}`"
              :disabled="acting === task.id"
              @click="confirming = task.id"
            >
              <AppIcon name="remove" :size="12" />
              Tear down
            </button>
          </Tooltip>
          <button
            v-else
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/60 px-2 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
            :data-testid="`teardown-confirm-${task.name}`"
            :disabled="acting === task.id"
            @click="confirming = undefined; teardown(task.id)"
          >
            <AppIcon name="remove" :size="12" />
            Really tear it down?
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
