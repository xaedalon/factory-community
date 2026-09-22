<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError, api, type PluginEntry, type ProviderEntry } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import AppIcon, { type IconName } from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
import SwitchInput from '../components/form/SwitchInput.vue'

/**
 * Every plugin, and the switch for each.
 *
 * This replaced a page that grouped what was installed by *kind*, which was
 * the right shape when the builder was its only reader — and those registries
 * are served better elsewhere. It read the host, and the host only knows what
 * loaded, so it could show neither the plugin you had just switched off nor
 * one that had failed to load. The catalogue knows all three.
 *
 * When a plugin's contribution does not appear here, this is where you find
 * out whether it loaded.
 */
const plugins = ref<PluginEntry[]>([])
const providers = ref<ProviderEntry[]>([])
const error = ref<string | undefined>(undefined)
const busy = ref<string | undefined>(undefined)

const restartNeeded = computed(() => plugins.value.some((entry) => entry.restartRequired))

async function load(): Promise<void> {
  try {
    plugins.value = (await api.plugins()).plugins
    providers.value = (await api.providers()).items
    error.value = undefined
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

async function toggle(entry: PluginEntry): Promise<void> {
  busy.value = entry.id
  try {
    await api.setPluginEnabled(entry.id, !entry.enabled)
    error.value = undefined
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    busy.value = undefined
  }
}

onMounted(load)

/** Where a plugin came from, drawn. */
const SOURCE_ICON: Record<string, IconName> = {
  builtin: 'check',
  scope: 'folder',
  unknown: 'alert',
}
const sourceIcon = (source: string): IconName => SOURCE_ICON[source] ?? 'link'
</script>

<template>
  <PageHeader
    title="Plugins"
    subtitle="Everything installed, what it contributes, and whether it is switched on."
  />

  <div class="space-y-6 px-8 py-6">
    <p
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      <AppIcon name="alert" class="mr-1 inline-block align-[-2px]" />
      {{ error }}
    </p>

    <!-- Said once at the top rather than per row: the host has no unload, so
         what is off stays loaded until the next start. -->
    <p
      v-if="restartNeeded"
      class="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm text-[var(--color-warn)]"
      data-testid="restart-required"
    >
      <AppIcon name="alert" class="mr-1 inline-block align-[-2px]" />
      Something is switched off but still loaded. Restart Factory to unload it.
    </p>

    <ul class="space-y-2">
      <li
        v-for="entry in plugins"
        :key="entry.id"
        class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3"
        :data-testid="`plugin-${entry.id}`"
      >
        <div class="flex flex-wrap items-baseline gap-3">
          <span class="value flex-1 truncate" :title="entry.id">{{ entry.name ?? entry.id }}</span>
          <span v-if="entry.version" class="font-mono text-[10px] text-[var(--color-ink-faint)]">
            {{ entry.version }}
          </span>
          <span
            class="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10px]"
            :class="
              entry.source === 'builtin'
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                : entry.source === 'scope'
                  ? 'bg-[var(--color-info)]/10 text-[var(--color-info)]'
                  : 'bg-[var(--color-warn)]/10 text-[var(--color-warn)]'
            "
            :data-testid="`plugin-source-${entry.id}`"
          >
            <AppIcon :name="sourceIcon(entry.source)" :size="10" class="mr-1 inline-block align-[-1px]" />
            {{ entry.source === 'scope' ? (entry.scope ?? 'scope') : entry.source }}
          </span>

          <!-- Listed with what it contributes but no switch: without these two
               nothing parses or runs, and a control that bricks the
               installation is not a choice worth offering. -->
          <Tooltip
            v-if="entry.essential"
            label="Nothing parses or runs without this, so there is no switch"
          >
            <span
              class="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-ink-faint)]"
              :data-testid="`plugin-essential-${entry.id}`"
            >
              <AppIcon name="profile" :size="10" />
              required
            </span>
          </Tooltip>
          <!-- The same switch as every other on/off in the app, rather than a
               button labelled with the state it is already in. The word stays
               beside it: a switch says which way it is thrown, and the word
               says what that means without anybody learning the convention. -->
          <Tooltip
            v-else
            :label="
              entry.enabled
                ? `Switch ${entry.name ?? entry.id} off — it stays loaded until Factory restarts`
                : `Switch ${entry.name ?? entry.id} on`
            "
          >
            <span class="inline-flex items-center gap-2">
              <!-- The testid goes on the control, not on the word beside it.
                   A test that clicks a label clicks nothing. -->
              <SwitchInput
                :model-value="entry.enabled"
                :disabled="busy === entry.id"
                :label="`Enable ${entry.name ?? entry.id}`"
                :data-testid="`plugin-toggle-${entry.id}`"
                @update:model-value="toggle(entry)"
              />
              <span
                class="font-mono text-[10px] tracking-wide"
                :class="entry.enabled ? 'text-[var(--color-ok)]' : 'text-[var(--color-ink-faint)]'"
                :data-testid="`plugin-state-${entry.id}`"
              >
                {{ entry.enabled ? 'on' : 'off' }}
              </span>
            </span>
          </Tooltip>
        </div>

        <p
          v-if="entry.error"
          class="mt-1 font-mono text-[11px] text-[var(--color-danger)]"
          :data-testid="`plugin-error-${entry.id}`"
        >
          {{ entry.error }}
        </p>
        <p
          v-else-if="entry.restartRequired"
          class="mt-1 font-mono text-[10px] text-[var(--color-warn)]"
          :data-testid="`plugin-restart-${entry.id}`"
        >
          off — restart to unload
        </p>
        <p
          v-else-if="entry.source === 'unknown'"
          class="mt-1 text-[11px] text-[var(--color-ink-faint)]"
          :data-testid="`plugin-unknown-${entry.id}`"
        >
          Switched off, and nothing declares it any more. Switch it on to forget it.
        </p>

        <p
          v-if="entry.provides.length > 0"
          class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--color-ink-muted)]"
        >
          <span
            v-for="given in entry.provides"
            :key="`${given.kind}:${given.id}`"
            class="rounded border border-[var(--color-line)] px-1.5 py-0.5"
          >
            <span class="text-[var(--color-ink-faint)]">{{ given.kind }}</span>:{{ given.id }}
          </span>
        </p>
      </li>
    </ul>

    <!-- Availability is about the CLI, not about the plugin, so it keeps its
         own section rather than being folded into a row above. -->
    <section v-if="providers.length > 0" data-testid="providers">
      <h2 class="mb-3 flex items-center gap-2 text-lg leading-snug font-medium">
        <AppIcon name="profile" :size="15" class="text-[var(--color-ink-muted)]" />
        Agents
      </h2>
      <ul class="space-y-2">
        <li
          v-for="provider in providers"
          :key="provider.id"
          class="flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3"
          :data-testid="`provider-${provider.id}`"
        >
          <span class="value w-24">{{ provider.id }}</span>
          <span
            class="inline-flex items-center gap-1 font-mono text-[10px] tracking-wide"
            :class="provider.available ? 'text-[var(--color-ok)]' : 'text-[var(--color-warn)]'"
          >
            <AppIcon :name="provider.available ? 'check' : 'alert'" :size="10" />
            {{ provider.available ? 'installed' : 'not installed' }}
          </span>
          <span
            v-if="provider.provisional"
            class="font-mono text-[10px] text-[var(--color-warn)]"
            :data-testid="`provisional-${provider.id}`"
          >
            unverified descriptor
          </span>
          <span class="ml-auto font-mono text-[10px] text-[var(--color-ink-faint)]">
            {{ Object.entries(provider.models).map(([role, id]) => `${role}=${id}`).join('  ') }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
