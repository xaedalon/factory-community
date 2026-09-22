<script setup lang="ts">
import type { ImportItem } from '../../api/client.js'

/**
 * What an import would do, item by item.
 *
 * Rendered from the plan the daemon returns, and the same plan is what gets
 * applied — so this is a preview in the strict sense rather than a second
 * guess at the outcome.
 *
 * `shadows` earns its column. A name free in the target scope but present in a
 * lower one is not a conflict, so nothing stops the write; it just quietly
 * changes which definition wins from then on.
 */
defineProps<{ items: ImportItem[] }>()

const tone = (action: ImportItem['action']) =>
  ({
    create: 'text-[var(--color-ok)]',
    overwrite: 'text-[var(--color-warn)]',
    conflict: 'text-[var(--color-danger)]',
    skip: 'text-[var(--color-ink-faint)]',
  })[action]
</script>

<template>
  <table class="w-full border-collapse" data-testid="import-plan">
    <thead>
      <tr class="border-b border-[var(--color-line)] text-left">
        <th
          v-for="heading in ['Action', 'Kind', 'Name', 'Notes']"
          :key="heading"
          class="pb-2 font-mono text-label font-normal text-[var(--color-ink-faint)] uppercase"
        >
          {{ heading }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="item in items"
        :key="`${item.kind}:${item.targetName}`"
        class="border-b border-[var(--color-line)]"
        :data-testid="`plan-${item.targetName}`"
      >
        <td class="py-2 pr-4">
          <span class="font-mono text-[11px]" :class="tone(item.action)">{{ item.action }}</span>
        </td>
        <td class="py-2 pr-4 font-mono text-[11px] text-[var(--color-ink-faint)]">
          {{ item.kind }}
        </td>
        <td class="py-2 pr-4">
          <span class="value">{{ item.targetName }}</span>
          <span
            v-if="item.targetName !== item.name"
            class="ml-2 font-mono text-[10px] text-[var(--color-ink-faint)]"
            :data-testid="`plan-${item.targetName}-renamed`"
          >
            was {{ item.name }}
          </span>
        </td>
        <td class="py-2 font-mono text-[10px]">
          <span
            v-if="item.shadows"
            class="text-[var(--color-warn)]"
            :data-testid="`plan-${item.targetName}-shadows`"
          >
            will hide the {{ item.shadows }} copy
          </span>
          <span v-else class="text-[var(--color-ink-faint)]">{{ item.targetPath }}</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
