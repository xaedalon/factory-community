<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { api, type DefinitionListing, type WorkflowChoice } from '../api/client.js'
import { useProjects } from '../stores/projects.js'
import { useTasks } from '../stores/tasks.js'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import FieldRow from '../components/form/FieldRow.vue'
import TextInput from '../components/form/TextInput.vue'
import WorkflowPicker from '../components/WorkflowPicker.vue'

/**
 * Creating a task.
 *
 * Its own page rather than a panel that unfolds above the board. Choosing an
 * ordered list of workflows is the substance of a task, not a detail, and a
 * form that pushes the board down the screen while you do it makes the board
 * the thing you are looking at and the decision the thing in the way.
 */
const router = useRouter()
const chosen = useProjects()
const tasks = useTasks()
const { items: projects } = storeToRefs(chosen)
const { error } = storeToRefs(tasks)

/**
 * Written out here because a Vue interpolation cannot contain `}}` — the
 * template parser closes on the first one it sees, whatever is around it.
 */
const DESCRIPTION_TOKEN = '{{ task.description }}'

const name = ref('')
const description = ref('')
const ticketId = ref('')
const branch = ref('')
// Defaults to whatever the rail is showing: creating a task while looking at a
// project almost always means creating it there. When the rail shows
// everything, the first project is chosen rather than none — a task cannot be
// created without one, and an empty select that refuses on submit is a worse
// way to learn that than a filled one you can change.
const projectId = ref(chosen.projectId ?? '')
const workflows = ref<WorkflowChoice[]>([])
const available = ref<DefinitionListing[]>([])
const busy = ref(false)
// So the empty state is not flashed before the first list arrives.
const loaded = ref(false)

/** What this project can run — its own scope, layered over the shared ones. */
async function loadWorkflows(): Promise<void> {
  try {
    available.value = (
      await api.list('workflow', projectId.value === '' ? undefined : projectId.value)
    ).items
  } catch {
    // The form still works without the list; you can only not click a name in.
    available.value = []
  }
}

onMounted(async () => {
  await chosen.load()
  if (projectId.value === '') projectId.value = projects.value[0]?.id ?? ''
  loaded.value = true
  void loadWorkflows()
})
// Changing the project changes which workflows exist, so the list is fetched
// again rather than filtered — and anything already chosen stays, flagged by
// the picker if the new project cannot resolve it.
watch(projectId, loadWorkflows)

async function submit(): Promise<void> {
  if (name.value.trim() === '' || projectId.value === '' || busy.value) return
  busy.value = true
  const id = await tasks.create({
    name: name.value.trim(),
    ...(description.value.trim() === '' ? {} : { description: description.value.trim() }),
    ...(ticketId.value.trim() === '' ? {} : { ticketId: ticketId.value.trim() }),
    ...(branch.value.trim() === '' ? {} : { branch: branch.value.trim() }),
    projectId: projectId.value,
    workflows: workflows.value.map((entry) => entry.workflow),
  })
  busy.value = false
  // Straight to the task, which is the next thing you want to look at.
  if (id !== undefined) await router.push(`/tasks/${id}`)
}
</script>

<template>
  <PageHeader title="New task" subtitle="A name, what it is for, where it happens, and what it runs — in order." />

  <div class="px-8 py-6">
    <!--
      A task happens in a project, so with none registered there is nothing to
      fill in. The form is not shown disabled: the thing to do is add a
      repository, and that is the only control offered.
    -->
    <div
      v-if="loaded && projects.length === 0"
      class="max-w-2xl rounded-lg border border-dashed border-[var(--color-line)] px-6 py-12 text-center"
      data-testid="new-task-needs-project"
    >
      <AppIcon name="project" :size="22" class="mx-auto text-[var(--color-ink-faint)]" />
      <p class="mt-3 text-sm text-[var(--color-ink-muted)]">
        A task happens in a project, and there are none yet. A project is the repository Factory
        does the work in.
      </p>
      <div class="mt-4 flex justify-center">
        <AppButton
          label="Add a repository"
          icon="add"
          tone="primary"
          data-testid="new-task-add-project"
          @click="router.push('/projects/new')"
        />
      </div>
    </div>

    <form v-else class="max-w-2xl" data-testid="new-task-form" @submit.prevent="submit">
      <FieldRow
        label="Name"
        icon="tasks"
        required
        for="task-name"
        hint="What the board will call this. A workflow derives the task's directory and branch from it when nothing else says otherwise."
      >
        <TextInput id="task-name" v-model="name" data-testid="task-name" placeholder="What needs doing" />
      </FieldRow>

      <FieldRow
        label="Ticket"
        icon="link"
        for="task-ticket"
        hint="Your tracker's id for this work, if it has one. Shown on the board so a row can be matched to the ticket it came from."
      >
        <TextInput id="task-ticket" v-model="ticketId" mono data-testid="task-ticket" placeholder="WW2-20742" />
      </FieldRow>

      <FieldRow
        label="Branch"
        icon="branch"
        for="task-branch"
        hint="The branch this task's work goes on. Left empty, a workflow derives one from the name."
      >
        <TextInput id="task-branch" v-model="branch" mono data-testid="task-branch" placeholder="feature/due-dates" />
      </FieldRow>

      <!-- Full width, because it is prose and a third of a row is not enough
           of it. It is also a token, so what goes here is what a prompt can
           quote — which is worth saying where it is typed. -->
      <FieldRow label="Description" icon="edit" for="task-description">
        <textarea
          id="task-description"
          v-model="description"
          data-testid="task-description"
          rows="3"
          placeholder="What the work is for, in your own words."
          class="w-full resize-y rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-1.5 text-sm placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <p class="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--color-ink-faint)]">
          <AppIcon name="info" :size="12" class="mt-0.5" />
          <span>
            An agent step can quote this with
            <code class="value text-[var(--color-accent-text)]">{{ DESCRIPTION_TOKEN }}</code>, so
            it is part of the prompt and not just a note.
          </span>
        </p>
      </FieldRow>

      <FieldRow
        label="Project"
        icon="project"
        for="task-project"
        hint="The repository this work happens in. It decides where the steps run and where the worktree goes."
      >
        <select
          id="task-project"
          v-model="projectId"
          data-testid="task-project"
          class="field-control"
        >
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
      </FieldRow>

      <FieldRow
        label="Workflows"
        icon="play"
        hint="The task stops at the first one that asks for approval, and waits there for you. Drag to reorder."
      >
        <WorkflowPicker
          v-model="workflows"
          :available="available"
          :editable="true"
          :project="projectId === '' ? undefined : projectId"
        />
      </FieldRow>

      <p
        v-if="error"
        class="mt-4 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
        data-testid="error"
      >
        <AppIcon name="alert" class="mt-0.5" />
        {{ error }}
      </p>

      <div class="mt-6 flex items-center gap-2 border-t border-[var(--color-line)] pt-5">
        <AppButton
          label="Create task"
          icon="add"
          tone="primary"
          type="submit"
          :disabled="busy"
          hint="Make the task as a draft — nothing runs until it is queued"
          data-testid="create-task"
        />
        <AppButton label="Cancel" data-testid="cancel-task" @click="router.push('/tasks')" />
      </div>
    </form>
  </div>
</template>
