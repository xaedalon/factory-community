<script setup lang="ts">
/**
 * The app's icons, in one file.
 *
 * There were none. Every control was a word, which is defensible for a nav and
 * expensive everywhere else: a row of six text buttons is six things to read
 * before you can act, and "Remove" next to "Use environments" gives no hint
 * that one of them is destructive.
 *
 * Inline SVG rather than a font or a sprite, because they are few and they
 * inherit `currentColor` — an icon in a danger-coloured button is the right red
 * without anyone saying so. One stroke weight, one 24-unit grid, `square`
 * corners nowhere: they have to sit beside 11px mono labels without shouting.
 *
 * Add a name here rather than pasting a path into a component. That is the
 * whole point of the file, and it is the same argument `states.ts` makes.
 */
export type IconName =
  | 'add'
  | 'alert'
  | 'back'
  | 'branch'
  | 'check'
  | 'copy'
  | 'diff'
  | 'edit'
  | 'environment'
  | 'export'
  | 'folder'
  | 'import'
  | 'info'
  | 'link'
  | 'play'
  | 'profile'
  | 'project'
  | 'refresh'
  | 'remove'
  | 'search'
  | 'settings'
  | 'stop'
  | 'tasks'
  | 'terminal'
  | 'worktree'

const PATHS: Record<IconName, string> = {
  add: 'M12 5v14M5 12h14',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  back: 'M19 12H5M12 19l-7-7 7-7',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  check: 'M20 6 9 17l-5-5',
  copy: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1ZM16 5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1',
  diff: 'M6 3v8M3 6h6M6 17a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15 21h6M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 9v12',
  edit: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  environment: 'M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5',
  export: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  import: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  info: 'M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  link: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  play: 'M6 3.5v17l14-8.5Z',
  profile: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  project: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM9 13h6',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  remove: 'M4 7h16M10 11v6M14 11v6M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  settings: 'M4 6h16M4 12h16M4 18h16M9 6v0M15 12v0M7 18v0',
  stop: 'M6 6h12v12H6z',
  tasks: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  terminal: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM7 10l2.5 2.5L7 15M12.5 15h4',
  worktree: 'M6 3v6a3 3 0 0 0 3 3h6M6 3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
}

withDefaults(defineProps<{ name: IconName; size?: number | undefined }>(), { size: 14 })
</script>

<template>
  <!-- `aria-hidden` always. An icon beside a word is decoration, and an icon
       standing alone is inside a control that carries the label itself — so
       there is no case where a screen reader should read this twice. -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0"
    aria-hidden="true"
    focusable="false"
    :data-icon="name"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
