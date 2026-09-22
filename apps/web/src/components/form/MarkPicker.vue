<script setup lang="ts">
import { computed } from 'vue'
import { PROJECT_TONES, initials as derivedInitials, tone as derivedTone } from '../../identity.js'
import AppIcon from '../AppIcon.vue'
import Tooltip from '../Tooltip.vue'

/**
 * The square a project gets in the rail, and whether it picks it.
 *
 * Both halves default to derived — a hash of the name for the hue, the first
 * letters of its words for the text — which is what every project did before
 * this existed and what a new one still does. `identity.ts` argues for that and
 * the argument holds: nothing to decide, nothing to store, and every surface
 * agrees without being told.
 *
 * Two things a hash cannot do, though, and they are why this is here. It cannot
 * survive a rename: the hash changes, so a square somebody had learned changes
 * colour under them. And six hues over a dozen projects collide often enough
 * that "the teal one" stops identifying anything.
 *
 * So: a live preview of the real square, six swatches plus Automatic, and two
 * characters. Choosing nothing is a position, not an absence, and it is the one
 * the buttons return to.
 */
const props = defineProps<{
  name: string
  tone: number | undefined
  initials: string | undefined
}>()
const emit = defineEmits<{
  'update:tone': [value: number | undefined]
  'update:initials': [value: string | undefined]
}>()

const hues = Array.from({ length: PROJECT_TONES }, (_, index) => index + 1)

// What the square would be with nothing chosen, so Automatic can show the
// answer rather than the word.
const automaticTone = computed(() => (props.name.trim() === '' ? 1 : derivedTone(props.name)))
const automaticLetters = computed(() =>
  props.name.trim() === '' ? '??' : derivedInitials(props.name),
)

const shownTone = computed(() => props.tone ?? automaticTone.value)
const shownLetters = computed(() =>
  props.initials !== undefined && props.initials !== '' ? props.initials : automaticLetters.value,
)
</script>

<template>
  <div class="flex items-start gap-4">
    <!-- The real thing at the real size, because the point of the control is
         what the rail will look like and a swatch grid does not answer that. -->
    <div class="flex flex-col items-center gap-1.5">
      <span
        class="flex h-10 w-10 items-center justify-center rounded-lg text-xs font-medium text-white"
        :style="{ backgroundColor: `var(--color-project-${shownTone})` }"
        data-testid="mark-preview"
        aria-hidden="true"
      >
        {{ shownLetters }}
      </span>
      <span class="font-mono text-[10px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        Rail
      </span>
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <Tooltip :label="`Follow the name — ${automaticLetters} in hue ${automaticTone}`">
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors"
            :class="
              tone === undefined
                ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)]'
            "
            data-testid="tone-auto"
            :aria-pressed="tone === undefined"
            @click="emit('update:tone', undefined)"
          >
            <AppIcon name="refresh" :size="11" />
            Automatic
          </button>
        </Tooltip>

        <Tooltip v-for="hue in hues" :key="hue" :label="`Colour ${hue}`">
          <button
            type="button"
            class="h-7 w-7 rounded-md border-2 transition-transform"
            :class="tone === hue ? 'border-[var(--color-ink)]' : 'border-transparent hover:scale-110'"
            :style="{ backgroundColor: `var(--color-project-${hue})` }"
            :data-testid="`tone-${hue}`"
            :aria-pressed="tone === hue"
            :aria-label="`Colour ${hue}`"
            @click="emit('update:tone', hue)"
          />
        </Tooltip>
      </div>

      <div class="mt-3 flex items-center gap-2">
        <label
          for="project-initials"
          class="font-mono text-[10px] tracking-widest text-[var(--color-ink-faint)] uppercase"
        >
          Letters
        </label>
        <input
          id="project-initials"
          :value="initials ?? ''"
          maxlength="2"
          data-testid="project-initials"
          :placeholder="automaticLetters"
          class="value w-16 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-2 py-1 text-center uppercase placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
          @input="
            emit(
              'update:initials',
              ($event.target as HTMLInputElement).value.toUpperCase() || undefined,
            )
          "
        />
        <span class="text-xs text-[var(--color-ink-faint)]">
          Two at most. Empty follows the name.
        </span>
      </div>
    </div>
  </div>
</template>
