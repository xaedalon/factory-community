<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ApiError, api, type ExecutionProfile, type Project } from '../api/client.js'
import { initials, toneVariable } from '../identity.js'
import PageHeader from '../components/PageHeader.vue'

/**
 * The repositories Factory works in.
 *
 * A path rather than a picker: the browser cannot choose a directory on the
 * machine, and the daemon is the only side that can say whether the path is
 * real — so it is typed, sent, and checked where the truth is.
 */
const projects = ref<Project[]>([])
const name = ref('')
const path = ref('')
const branch = ref('')
const usesWorktrees = ref(true)
const usesEnvironments = ref(false)
const error = ref<string | undefined>(undefined)

async function load(): Promise<void> {
  try {
    projects.value = (await api.projects()).items
    error.value = undefined
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

async function add(): Promise<void> {
  error.value = undefined
  try {
    await api.addProject({
      name: name.value.trim(),
      path: path.value.trim(),
      ...(branch.value.trim() === '' ? {} : { defaultBranch: branch.value.trim() }),
      usesWorktrees: usesWorktrees.value,
      usesEnvironments: usesEnvironments.value,
    })
    name.value = ''
    path.value = ''
    branch.value = ''
    usesWorktrees.value = true
    usesEnvironments.value = false
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

async function remove(project: Project): Promise<void> {
  await api.removeProject(project.id)
  await load()
}

/**
 * Turn a setting on or off for a project that already exists.
 *
 * The refusal that matters — worktrees on where there is no repository — comes
 * back from the daemon, which is the only side that can look. So does the list
 * of files turning a setting on put into the repository, which is worth saying
 * out loud: Factory has just written into somebody's working copy.
 */
const scaffolded = ref<string[]>([])

async function toggle(
  project: Project,
  setting: { usesWorktrees?: boolean; usesEnvironments?: boolean },
): Promise<void> {
  error.value = undefined
  scaffolded.value = []
  try {
    const result = await api.setProjectSetting(project.id, setting)
    scaffolded.value = result.scaffolded.written
    if (result.scaffolded.error !== undefined) error.value = result.scaffolded.error
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

/**
 * Say how much authority this project's runs get.
 *
 * The empty string means "hasn't chosen", and is sent as `null` — which the
 * route reads as clear-it. Choosing `default` is a different thing: it pins the
 * project against an installation that later switches to Full Access.
 */
async function setProfile(project: Project, value: string): Promise<void> {
  error.value = undefined
  scaffolded.value = []
  try {
    await api.setProjectSetting(project.id, {
      profile: value === '' ? null : (value as ExecutionProfile),
    })
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

onMounted(load)
</script>

<template>
  <PageHeader title="Projects" subtitle="The repositories Factory runs work in." />

  <div class="px-8 py-6">
    <form
      class="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
      data-testid="add-project"
      @submit.prevent="add"
    >
      <label class="flex flex-col gap-1">
        <span class="text-xs text-[var(--color-ink-muted)]">Name</span>
        <input
          v-model="name"
          data-testid="project-name"
          class="w-40 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-base)] px-2.5 py-1.5 text-sm"
        />
      </label>
      <label class="flex flex-1 flex-col gap-1">
        <span class="text-xs text-[var(--color-ink-muted)]">Path</span>
        <input
          v-model="path"
          data-testid="project-path"
          placeholder="/Users/you/projects/thing"
          class="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-base)] px-2.5 py-1.5 font-mono text-sm"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-[var(--color-ink-muted)]">Branch</span>
        <input
          v-model="branch"
          data-testid="project-branch"
          placeholder="main"
          class="w-28 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-base)] px-2.5 py-1.5 text-sm"
        />
      </label>
      <label class="flex items-center gap-2 pb-1.5">
        <input
          v-model="usesWorktrees"
          type="checkbox"
          data-testid="project-worktrees"
          class="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
        <span class="text-xs text-[var(--color-ink-muted)]">
          A worktree per task
          <span class="text-[var(--color-ink-faint)]">
            — off: work happens in the repository, one task at a time. Worktrees go beside the
            project, never inside it.
          </span>
        </span>
      </label>
      <label class="flex items-center gap-2 pb-1.5">
        <input
          v-model="usesEnvironments"
          type="checkbox"
          data-testid="project-environments"
          class="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
        <span class="text-xs text-[var(--color-ink-muted)]">
          An environment per task
          <span class="text-[var(--color-ink-faint)]">
            — copies environment workflows in for you to write
          </span>
        </span>
      </label>

      <button
        type="submit"
        data-testid="create-project"
        class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white"
      >
        Add project
      </button>
    </form>

    <p
      v-if="error"
      class="mb-4 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </p>

    <!-- Factory has just written into a working copy. Say which files, because
         the next thing that happens is a `git status` nobody was expecting. -->
    <div
      v-if="scaffolded.length > 0"
      class="mb-4 rounded-lg border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-4 py-3 text-sm text-[var(--color-info)]"
      data-testid="scaffolded"
    >
      <p>Copied into the project, ready to edit and commit:</p>
      <ul class="mt-1 space-y-0.5">
        <li v-for="file in scaffolded" :key="file" class="font-mono text-xs">{{ file }}</li>
      </ul>
    </div>

    <p
      v-if="projects.length === 0"
      class="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-10 text-center text-sm text-[var(--color-ink-muted)]"
      data-testid="projects-empty"
    >
      No projects yet. Add the repository you want Factory to work in.
    </p>

    <ul v-else class="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
      <!--
        Three groups, not nine siblings.

        The row was already `items-center`, but the pieces were loose: a
        two-line name-over-path block sized by its own content, then badges,
        branch, count and two buttons all as equals. Centring then put every
        one-line sibling against the middle of a two-line row — floating in the
        gutter between the name and the path — and the name block having
        `min-w-0` without `flex-1` meant `truncate` never engaged, so a long
        path shoved everything right and no two rows lined up. Identity, then
        what it is, then what you can do about it.
      -->
      <li
        v-for="project in projects"
        :key="project.id"
        class="flex items-center gap-4 px-4 py-3"
        :data-testid="`project-${project.name}`"
      >
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-medium text-white"
          :style="{ backgroundColor: toneVariable(project.name) }"
          :data-testid="`project-mark-${project.name}`"
          aria-hidden="true"
        >
          {{ initials(project.name) }}
        </span>

        <div class="flex min-w-0 flex-1 flex-col">
          <p class="truncate text-sm">{{ project.name }}</p>
          <p class="truncate font-mono text-xs text-[var(--color-ink-muted)]">{{ project.path }}</p>
        </div>

        <div class="flex shrink-0 items-center gap-3">
          <span
            v-if="!project.isRepository"
            class="rounded-md bg-[var(--color-warn)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
            :data-testid="`not-a-repo-${project.name}`"
          >
            not a git repository
          </span>
          <span
            v-if="!project.usesWorktrees"
            class="rounded-md bg-[var(--color-veil-strong)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]"
            :data-testid="`shared-checkout-${project.name}`"
          >
            in the repository · one task at a time
          </span>
          <span
            v-if="project.usesEnvironments"
            class="rounded-md bg-[var(--color-info)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-info)]"
            :data-testid="`environments-${project.name}`"
          >
            an environment per task
          </span>
          <span class="font-mono text-[11px] text-[var(--color-ink-faint)]">
            {{ project.defaultBranch }}
          </span>
          <!-- Fixed width, so the count sits in the same place in every row
               rather than shifting with the number of digits. -->
          <span class="w-16 text-right font-mono text-[11px] text-[var(--color-ink-faint)]">
            {{ project.tasks }} task{{ project.tasks === 1 ? '' : 's' }}
          </span>
          <button
            type="button"
            :data-testid="`toggle-worktrees-${project.name}`"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            @click="toggle(project, { usesWorktrees: !project.usesWorktrees })"
          >
            {{ project.usesWorktrees ? 'Work in the repository' : 'Use worktrees' }}
          </button>
          <button
            type="button"
            :data-testid="`toggle-environments-${project.name}`"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            @click="toggle(project, { usesEnvironments: !project.usesEnvironments })"
          >
            {{ project.usesEnvironments ? 'No environments' : 'Use environments' }}
          </button>
          <!-- A select rather than a toggle, because there are three positions
               and one of them is "hasn't chosen". A button cycling through
               three is a button nobody can predict, and the third position is
               the one that matters: a project that states nothing follows the
               installation, so changing that setting changes it. -->
          <select
            :data-testid="`profile-${project.name}`"
            class="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-xs"
            :class="
              project.profile === 'full-access'
                ? 'border-[var(--color-warn)]/60 text-[var(--color-warn)]'
                : 'text-[var(--color-ink-muted)]'
            "
            :value="project.profile ?? ''"
            @change="setProfile(project, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Follows installation</option>
            <option value="default">Default</option>
            <option value="full-access">Full Access</option>
          </select>
          <button
            type="button"
            :data-testid="`remove-${project.name}`"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-danger)]"
            @click="remove(project)"
          >
            Remove
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
