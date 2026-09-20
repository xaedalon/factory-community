<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ApiError, api, type ArtifactDetail } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import MarkdownView from '../components/MarkdownView.vue'

/**
 * One artifact, readable.
 *
 * Until now the only way to see what an agent wrote was a `<pre>` of Markdown
 * source inside a run's evidence panel, and only if you opened the right run.
 * These are documents — eight to thirteen kilobytes of headings, lists and
 * tables — written to be read.
 *
 * Addressed by task and name rather than by a file path. The prototype's
 * viewer took `?path=` and the server read whatever it was given; here the
 * content comes out of the evidence rows, so there is no path to validate and
 * nothing to traverse.
 */
const route = useRoute()
const taskId = computed(() => String(route.params.id))
const name = computed(() => String(route.params.name))

const detail = ref<ArtifactDetail | undefined>(undefined)
const error = ref<string | undefined>(undefined)
/** Which run's copy is showing. Index into `versions`, newest first. */
const at = ref(0)

const showing = computed(() => detail.value?.versions[at.value])

async function load(): Promise<void> {
  detail.value = undefined
  error.value = undefined
  at.value = 0
  try {
    detail.value = await api.artifact(taskId.value, name.value)
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

onMounted(load)
watch([taskId, name], load)

/** Dates are stamped by the daemon; the reader wants them legible. */
const when = (iso: string): string => new Date(iso).toLocaleString()
</script>

<template>
  <PageHeader :title="name" :subtitle="detail?.phase ? `produced by ${detail.phase}` : undefined" />

  <div class="px-8 py-6">
    <RouterLink
      :to="`/tasks/${taskId}`"
      class="mb-4 inline-block font-mono text-[11px] text-[var(--color-accent-text)] hover:underline"
      data-testid="back-to-task"
    >
      ← back to the task
    </RouterLink>

    <p
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </p>

    <template v-else-if="detail">
      <!-- The path, as the prototype shows it: this is the file on disk, and
           knowing where it is is half of why you opened the page. -->
      <p
        class="mb-4 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] break-all text-[var(--color-ink-faint)]"
        data-testid="artifact-path"
      >
        {{ detail.path }}
      </p>

      <!-- Only when there is more than one: a picker offering one choice is
           furniture. Each run wrote a version, so this is the history. -->
      <div
        v-if="detail.versions.length > 1"
        class="mb-4 flex flex-wrap items-center gap-2"
        data-testid="artifact-versions"
      >
        <span class="font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Versions
        </span>
        <button
          v-for="(version, index) in detail.versions"
          :key="version.runId"
          type="button"
          class="rounded-md border px-2 py-1 font-mono text-[10px]"
          :class="
            index === at
              ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
              : 'border-[var(--color-line)] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]'
          "
          :data-testid="`version-${index}`"
          @click="at = index"
        >
          {{ when(version.collectedAt) }}{{ index === 0 ? ' · latest' : '' }}
        </button>
      </div>

      <p
        v-if="showing?.missing"
        class="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm text-[var(--color-warn)]"
        data-testid="artifact-missing"
      >
        The step promised this and never produced it.
      </p>

      <MarkdownView
        v-else-if="showing?.content"
        :markdown="showing.content"
        data-testid="artifact-content"
      />

      <p v-else class="text-sm text-[var(--color-ink-faint)]" data-testid="artifact-unreadable">
        Nothing readable was stored — the file did not look like text.
      </p>

      <p
        v-if="showing?.truncated"
        class="mt-4 text-[11px] text-[var(--color-warn)]"
        data-testid="artifact-truncated"
      >
        Showing the first part. The file on disk is {{ showing.bytes }} bytes; open the path above for
        the rest.
      </p>
    </template>
  </div>
</template>
