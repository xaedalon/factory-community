<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ApiError, api, type Project } from '../api/client.js'
import { markInitials, markTone } from '../identity.js'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'

/**
 * The repositories Factory works in.
 *
 * A list, and nothing else. Every control that used to live here — the
 * seven-field add strip above it, and the two state-named toggle buttons, the
 * profile select and the unconfirmed Remove inside every row — is on the
 * project's own page now. A row's job is to say what a project is and let you
 * open it.
 *
 * What stays is what a list is for: enough of each project to tell them apart,
 * and the facts you would otherwise have to open each one to discover.
 */
const router = useRouter()
const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref<string | undefined>(undefined)

/**
 * What the project page just wrote into a repository, handed over on the way.
 *
 * Turning worktrees or environments on copies workflow files into somebody's
 * working copy. That is a thing Factory did to their repository and the next
 * thing they do is a `git status`, so it is said out loud — on the page they
 * land on, not the one they left.
 */
const scaffolded = ref<string[]>(
  Array.isArray(window.history.state?.scaffolded) ? window.history.state.scaffolded : [],
)

async function load(): Promise<void> {
  try {
    projects.value = (await api.projects()).items
    error.value = undefined
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <PageHeader title="Projects" subtitle="The repositories Factory runs work in.">
    <template #actions>
      <AppButton
        label="New project"
        icon="add"
        tone="primary"
        hint="Point Factory at a repository on this machine"
        data-testid="new-project"
        @click="router.push('/projects/new')"
      />
    </template>
  </PageHeader>

  <div class="page-body">
    <p
      v-if="error"
      class="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      <AppIcon name="alert" class="mt-0.5" />
      {{ error }}
    </p>

    <div
      v-if="scaffolded.length > 0"
      class="rounded-lg border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-4 py-3 text-sm text-[var(--color-info)]"
      data-testid="scaffolded"
    >
      <p class="flex items-center gap-2">
        <AppIcon name="info" />
        Copied into the project, ready to edit and commit:
      </p>
      <ul class="mt-1 space-y-0.5">
        <li v-for="file in scaffolded" :key="file" class="font-mono text-xs">{{ file }}</li>
      </ul>
    </div>

    <p v-if="loading" class="text-sm text-[var(--color-ink-muted)]">Loading…</p>

    <div
      v-else-if="projects.length === 0"
      class="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-12 text-center"
      data-testid="projects-empty"
    >
      <AppIcon name="project" :size="22" class="mx-auto text-[var(--color-ink-faint)]" />
      <p class="mt-3 text-sm text-[var(--color-ink-muted)]">
        No projects yet. A project is the repository Factory does the work in.
      </p>
      <div class="mt-4 flex justify-center">
        <AppButton
          label="Add a repository"
          icon="add"
          tone="primary"
          data-testid="new-project-empty"
          @click="router.push('/projects/new')"
        />
      </div>
    </div>

    <ul
      v-else
      class="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]"
    >
      <li v-for="project in projects" :key="project.id" :data-testid="`project-${project.name}`">
        <!-- The whole row is the link. A row with one small "Edit" in it makes
             a person aim at a target the size of a word when the target they
             mean is the project. -->
        <RouterLink
          :to="`/projects/${project.id}`"
          class="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-veil-weak)]"
          :data-testid="`open-project-${project.name}`"
        >
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-medium text-white"
            :style="{ backgroundColor: markTone(project) }"
            :data-testid="`project-mark-${project.name}`"
            aria-hidden="true"
          >
            {{ markInitials(project) }}
          </span>

          <div class="flex min-w-0 flex-1 flex-col">
            <p class="truncate text-sm">{{ project.name }}</p>
            <p class="flex items-center gap-1.5 truncate font-mono text-xs text-[var(--color-ink-muted)]">
              <AppIcon name="folder" :size="11" />
              {{ project.path }}
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <Tooltip v-if="!project.isRepository" label="No .git directory, so it cannot use worktrees">
              <span
                class="flex items-center gap-1 rounded-md bg-[var(--color-warn)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
                :data-testid="`not-a-repo-${project.name}`"
              >
                <AppIcon name="alert" :size="10" />
                not a git repository
              </span>
            </Tooltip>

            <Tooltip
              v-if="!project.usesWorktrees"
              label="Work happens in the repository itself, so one task runs at a time"
            >
              <span
                class="flex items-center gap-1 rounded-md bg-[var(--color-veil-strong)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]"
                :data-testid="`shared-checkout-${project.name}`"
              >
                <AppIcon name="folder" :size="10" />
                in the repository
              </span>
            </Tooltip>

            <Tooltip
              v-if="project.usesEnvironments"
              label="Environment workflows are copied in for this project to own"
            >
              <span
                class="flex items-center gap-1 rounded-md bg-[var(--color-info)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-info)]"
                :data-testid="`environments-${project.name}`"
              >
                <AppIcon name="environment" :size="10" />
                an environment per task
              </span>
            </Tooltip>

            <Tooltip
              v-if="project.profile === 'full-access'"
              label="Agents here are not confined to the workspace"
            >
              <span
                class="flex items-center gap-1 rounded-md bg-[var(--color-warn)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
                :data-testid="`full-access-${project.name}`"
              >
                <AppIcon name="profile" :size="10" />
                full access
              </span>
            </Tooltip>

            <Tooltip label="The branch work starts from">
              <span
                class="flex items-center gap-1 font-mono text-[11px] text-[var(--color-ink-faint)]"
              >
                <AppIcon name="branch" :size="11" />
                {{ project.defaultBranch }}
              </span>
            </Tooltip>

            <!-- Fixed width, so the count sits in the same place in every row
                 rather than shifting with the number of digits. -->
            <span class="w-16 text-right font-mono text-[11px] text-[var(--color-ink-faint)]">
              {{ project.tasks }} task{{ project.tasks === 1 ? '' : 's' }}
            </span>
          </div>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
