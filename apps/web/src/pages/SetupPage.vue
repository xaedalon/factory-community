<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, api, type SetupReport } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
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
  <PageHeader title="Setup" subtitle="What is still missing, and how to finish it.">
    <template #actions>
      <AppButton
        label="Check again"
        icon="refresh"
        hint="Ask every registered step again"
        data-testid="recheck"
        @click="load"
      />
    </template>
  </PageHeader>

  <div class="page-body">
    <p
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      <AppIcon name="alert" class="mt-0.5 inline-block" />
      {{ error }}
    </p>

    <div
      v-if="report"
      class="flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
      :class="
        report.ready
          ? 'border-[var(--color-ok)]/40 bg-[var(--color-ok)]/5 text-[var(--color-ok)]'
          : 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 text-[var(--color-warn)]'
      "
      data-testid="setup-summary"
    >
      <AppIcon :name="report.ready ? 'check' : 'alert'" class="mt-0.5" />
      <span>
      <template v-if="report.remaining === 0">Everything is set up.</template>
      <template v-else-if="report.ready">
        {{ report.remaining }} thing{{ report.remaining === 1 ? '' : 's' }} left, none of them
        blocking.
      </template>
      <template v-else>
        Factory cannot run work yet — the steps marked essential are what it is waiting for.
      </template>
      </span>
    </div>

    <ol v-if="report" class="space-y-2" data-testid="setup-steps">
      <li
        v-for="item in report.items"
        :key="item.id"
        class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
        :data-testid="`step-${item.id}`"
      >
        <header class="flex items-start gap-3">
          <!-- A drawn mark rather than a "✓" and a "•" typed as text. The
               two were the same weight at the same size, so a done step and a
               waiting one were told apart by the shape of one character. -->
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            :class="
              item.done
                ? 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]'
                : 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
            "
            :data-testid="`mark-${item.id}`"
          >
            <AppIcon :name="item.done ? 'check' : 'alert'" :size="12" />
          </span>
          <div class="min-w-0">
            <p class="text-sm">
              {{ item.title }}
              <span
                v-if="!item.done && item.essential"
                class="ml-1.5 inline-flex items-center gap-1 rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-danger)]"
                ><AppIcon name="alert" :size="10" />essential</span
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

            <!-- "click to copy" was instructions printed inside the control.
                 An icon says it, and the word only appears once it has
                 happened — which is the half worth saying. -->
            <Tooltip :label="`Copy: ${action.command}`">
              <button
                v-if="action.command"
                type="button"
                class="mt-1 flex w-full items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2 text-left font-mono text-[11px] text-[var(--color-ink)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-veil)]"
                :data-testid="`command-${item.id}-${index}`"
                @click="copy(action.command)"
              >
                <AppIcon name="copy" :size="12" class="shrink-0 text-[var(--color-ink-faint)]" />
                <span class="min-w-0 flex-1 break-all">{{ action.command }}</span>
                <span
                  v-if="copied === action.command"
                  class="shrink-0 text-[var(--color-ok)]"
                  :data-testid="`copied-${item.id}-${index}`"
                >
                  copied
                </span>
              </button>
            </Tooltip>

            <pre
              v-if="action.config"
              class="mt-1 overflow-x-auto rounded-md bg-[var(--color-base)] px-3 py-2 font-mono text-[11px] text-[var(--color-ink-muted)]"
              :data-testid="`config-${item.id}-${index}`"
            >{{ action.config }}</pre>

            <RouterLink
              v-if="action.url && action.url.startsWith('/')"
              :to="action.url"
              class="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--color-accent-text)] hover:underline"
              :data-testid="`go-${item.id}-${index}`"
            >
              {{ action.url }}
              <AppIcon name="go" :size="12" />
            </RouterLink>
            <a
              v-else-if="action.url"
              :href="action.url"
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--color-accent-text)] hover:underline"
              >{{ action.url }}<AppIcon name="link" :size="12" /></a
            >
          </div>
        </div>
      </li>
    </ol>

  </div>
</template>
