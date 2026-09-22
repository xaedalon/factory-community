<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ALL, useProjects } from '../stores/projects.js'
import { markInitials, markTone } from '../identity.js'

/**
 * Which project you are working in.
 *
 * Left of the navigation rather than inside it, because it is a different
 * question: the nav says which page, this says which project the page is
 * about. A list of names inside the nav — which is what the mockup had — grows
 * until it pushes the pages off the bottom of the screen, and reads as eight
 * more destinations rather than as one choice.
 */
const store = useProjects()
const { items, selected } = storeToRefs(store)

onMounted(() => {
  void store.load()
  store.connect()
})
onUnmounted(() => store.disconnect())

const square =
  'flex h-10 w-10 items-center justify-center rounded-lg text-[11px] font-medium transition-all'
</script>

<template>
  <aside
    class="app-rail flex w-16 shrink-0 flex-col items-center border-r border-[var(--color-line)] bg-[var(--color-base)]"
    aria-label="Projects"
  >
    <!-- The same py-5 band as the Factory mark next door, so the first square
         lines up with it rather than floating a few pixels off. -->
    <div class="py-5">
      <button
        type="button"
        data-testid="project-button-all"
        :class="[
          square,
          selected === ALL
            ? 'bg-[var(--color-accent)] text-white ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-base)]'
            : 'bg-[var(--color-raised)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
        ]"
        :aria-current="selected === ALL ? 'true' : undefined"
        title="Every project"
        @click="store.select(ALL)"
      >
        All
      </button>
    </div>

    <ul class="flex flex-col items-center gap-2">
      <li v-for="project in items" :key="project.id">
        <button
          type="button"
          :data-testid="`project-button-${project.name}`"
          :class="[
            square,
            selected === project.id
              ? 'text-white ring-2 ring-offset-2 ring-offset-[var(--color-base)]'
              : 'text-white/80 opacity-60 hover:opacity-100',
          ]"
          :style="{
            backgroundColor: markTone(project),
            ...(selected === project.id ? { '--tw-ring-color': markTone(project) } : {}),
          }"
          :aria-current="selected === project.id ? 'true' : undefined"
          :title="project.name"
          @click="store.select(project.id)"
        >
          {{ markInitials(project) }}
        </button>
      </li>
    </ul>

    <RouterLink
      to="/projects"
      data-testid="project-button-add"
      class="mt-2 flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--color-line-strong)] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink-muted)]"
      title="Add a project"
    >
      +
    </RouterLink>
  </aside>
</template>
