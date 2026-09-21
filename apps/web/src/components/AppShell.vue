<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { computed } from 'vue'
import ProjectRail from './ProjectRail.vue'
import DisclaimerPanel from './DisclaimerPanel.vue'
import AppIcon, { type IconName } from './AppIcon.vue'
import { useSettings } from '../stores/settings.js'

const route = useRoute()
const settings = useSettings()

/**
 * Grouped by what each page is about, not by how often it is used.
 *
 * Eight flat entries gave no clue that Tasks and Scopes answer completely
 * different kinds of question. Three groups do: what is happening, what you
 * author, and how this installation is put together.
 *
 * The first has no heading. It is what you open Factory to look at, and a
 * label above it would only name the obvious.
 */
const nav: { heading?: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  {
    items: [
      { to: '/tasks', label: 'Tasks', icon: 'tasks' },
      { to: '/environments', label: 'Environments', icon: 'environment' },
    ],
  },
  {
    heading: 'Library',
    items: [
      { to: '/workflows', label: 'Workflows', icon: 'play' },
      { to: '/phases', label: 'Phases', icon: 'settings' },
      { to: '/agents', label: 'Agents', icon: 'profile' },
      { to: '/bundles/import', label: 'Import', icon: 'import' },
    ],
  },
  {
    heading: 'System',
    items: [
      { to: '/projects', label: 'Projects', icon: 'project' },
      { to: '/scopes', label: 'Scopes', icon: 'folder' },
      { to: '/plugins', label: 'Plugins', icon: 'link' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
      { to: '/setup', label: 'Setup', icon: 'check' },
    ],
  },
]

const current = computed(() => route.path)
</script>

<template>
  <!-- The shell owns the viewport and `main` is the scroller, so the rails stay
       put on a long page. They used to be ordinary in-flow children stretched
       to the height of the whole document, which scrolled them off the top —
       and put the tagline below at the bottom of the *page* rather than the
       window. The editor pages already did it this way and never had the bug. -->
  <div class="app-viewport flex">
    <!-- Over everything, and only when the daemon says nothing has been
         accepted. Browsing is not gated; starting a run is. -->
    <DisclaimerPanel />

    <ProjectRail />

    <nav
      class="app-nav flex w-52 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]"
    >
      <div class="flex items-center gap-2 px-5 py-5">
        <span class="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-[var(--color-accent)]" />
        <span class="font-mono text-[13px] font-medium tracking-[0.18em] uppercase">Factory</span>
      </div>

      <!-- Here rather than in a banner or a page header, for two reasons. The
           shell is a flex *row* with no header slot, and wrapping it to add one
           would change what `@container (max-width: 900px)` measures — the
           container query is on `.app-viewport`, and the interface scale depends
           on it. And the nav survives that collapse: only `.app-rail` is hidden,
           the nav narrows to `w-40` and stays. So this is visible at every
           scale, which is the whole requirement. -->
      <div
        v-if="settings.unconfined"
        class="mx-3 mb-1 rounded-md border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2"
        data-testid="full-access-badge"
      >
        <p class="font-mono text-[10px] leading-tight tracking-widest text-[var(--color-warn)] uppercase">
          Full Access
        </p>
        <p class="mt-0.5 text-[10px] leading-tight text-[var(--color-ink-muted)]">
          Agents are not confined to the workspace.
        </p>
      </div>

      <div v-for="(section, index) in nav" :key="section.heading ?? index" class="px-2">
        <p
          v-if="section.heading"
          class="mt-5 mb-1 px-3 font-mono text-[10px] tracking-widest text-[var(--color-ink-faint)] uppercase"
          :data-testid="`nav-section-${section.heading.toLowerCase()}`"
        >
          {{ section.heading }}
        </p>
        <ul class="flex flex-col gap-0.5">
          <li v-for="item in section.items" :key="item.to">
            <RouterLink
              :to="item.to"
              :data-testid="`nav-${item.label.toLowerCase()}`"
              class="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors"
              :class="
                current.startsWith(item.to)
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]'
              "
            >
              <AppIcon :name="item.icon" />
              {{ item.label }}
            </RouterLink>
          </li>
        </ul>
      </div>

      <div class="mt-auto px-5 py-4 font-mono text-[10px] text-[var(--color-ink-faint)]">
        Don't replace your tools.<br />Orchestrate them.
      </div>
    </nav>

    <main class="min-w-0 flex-1 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>
