<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, api, type SetupReport } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import { useClipboard } from '../composables/useClipboard.js'

/**
 * What is still missing.
 *
 * Every item comes from a registered setup step — the agent check from the
 * provider plugins, the repository check from the engine, a licence check from
 * Pro. Nothing on this page is written here, which is what lets a plugin with
 * setup of its own appear on it.
 */
const report = ref<SetupReport | undefined>(undefined)
const error = ref<string | undefined>(undefined)
const { copied, copy } = useClipboard()

async function load(): Promise<void> {
  try {
    report.value = await api.setup()
    error.value = undefined
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

onMounted(load)
</script>

<template>
  <PageHeader title="Setup" subtitle="What is still missing, and how to finish it." />

  <div class="px-8 py-6">
    <p
      v-if="error"
      class="mb-4 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </p>

    <div
      v-if="report"
      class="mb-6 rounded-lg border px-4 py-3 text-sm"
      :class="
        report.ready
          ? 'border-[#34d399]/40 bg-[#34d399]/5 text-[#34d399]'
          : 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 text-[var(--color-warn)]'
      "
      data-testid="setup-summary"
    >
      <template v-if="report.remaining === 0">Everything is set up.</template>
      <template v-else-if="report.ready">
        {{ report.remaining }} thing{{ report.remaining === 1 ? '' : 's' }} left, none of them
        blocking.
      </template>
      <template v-else>
        Factory cannot run work yet — the steps marked essential are what it is waiting for.
      </template>
    </div>

    <ol v-if="report" class="space-y-3" data-testid="setup-steps">
      <li
        v-for="item in report.items"
        :key="item.id"
        class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
        :data-testid="`step-${item.id}`"
      >
        <header class="flex items-start gap-3">
          <span
            class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]"
            :class="
              item.done
                ? 'bg-[#34d399]/15 text-[#34d399]'
                : 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
            "
            >{{ item.done ? '✓' : '•' }}</span
          >
          <div class="min-w-0">
            <p class="text-sm">
              {{ item.title }}
              <span
                v-if="!item.done && item.essential"
                class="ml-1.5 rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-danger)]"
                >essential</span
              >
            </p>
            <p class="mt-0.5 text-xs text-[var(--color-ink-muted)]">{{ item.summary }}</p>
            <p v-if="item.detail" class="mt-1 text-xs text-[var(--color-ink-faint)]">
              {{ item.detail }}
            </p>
          </div>
        </header>

        <div v-if="item.actions?.length" class="mt-3 space-y-2 pl-7">
          <div v-for="(action, index) in item.actions" :key="index">
            <p class="text-xs text-[var(--color-ink-muted)]">{{ action.label }}</p>

            <button
              v-if="action.command"
              type="button"
              class="mt-1 block w-full rounded-md bg-[var(--color-base)] px-3 py-2 text-left font-mono text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-veil)]"
              :data-testid="`command-${item.id}-${index}`"
              @click="copy(action.command)"
            >
              {{ action.command }}
              <span class="ml-2 text-[var(--color-ink-faint)]">{{
                copied === action.command ? 'copied' : 'click to copy'
              }}</span>
            </button>

            <pre
              v-if="action.config"
              class="mt-1 overflow-x-auto rounded-md bg-[var(--color-base)] px-3 py-2 font-mono text-[11px] text-[var(--color-ink-muted)]"
              :data-testid="`config-${item.id}-${index}`"
            >{{ action.config }}</pre>

            <RouterLink
              v-if="action.url && action.url.startsWith('/')"
              :to="action.url"
              class="mt-1 inline-block text-xs text-[var(--color-accent)]"
              :data-testid="`go-${item.id}-${index}`"
            >
              {{ action.url }} →
            </RouterLink>
            <a
              v-else-if="action.url"
              :href="action.url"
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-block text-xs text-[var(--color-accent)]"
              >{{ action.url }} ↗</a
            >
          </div>
        </div>
      </li>
    </ol>

    <button
      type="button"
      class="mt-6 rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      data-testid="recheck"
      @click="load"
    >
      Check again
    </button>
  </div>
</template>
