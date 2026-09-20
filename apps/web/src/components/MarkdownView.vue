<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'

/**
 * Markdown, rendered, from text an agent wrote.
 *
 * The only place in this codebase that uses `v-html`, and deliberately the only
 * one: artifact text comes out of a language model, so it is untrusted input in
 * the ordinary sense — `<img src=x onerror=…>` in an analysis document must be
 * something you read, not something that runs. The prototype this follows
 * renders the same content through `v-html` with no sanitiser at all, which is the half of it not worth copying.
 *
 * So: parse, sanitise, then set. Keeping it in one component means there is one
 * place to check that, rather than a rule everybody has to remember.
 */
const props = defineProps<{ markdown: string }>()

/**
 * A link out of an artifact opens away from the board.
 *
 * Carried over from the prototype, for the same reason: the board is a single
 * page and following a link inside it would lose whatever you were looking at.
 * `rel` is what stops the new tab reaching back.
 */
const renderer = new Renderer()
renderer.link = ({ href, title, text }) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer"${
    title === null || title === undefined ? '' : ` title="${title}"`
  }>${text}</a>`
const marked = new Marked({ renderer, gfm: true, breaks: false })

const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.markdown, { async: false }) as string, {
    // `target` is not on DOMPurify's default allow-list, so without this the
    // renderer above would be silently undone.
    ADD_ATTR: ['target'],
  }),
)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitised immediately above -->
  <article class="prose" v-html="html" />
</template>

<style scoped>
/*
 * Ported from the prototype's `.prose-content`, onto this project's tokens
 * rather than its own hard-coded colours: `--text-primary` became
 * `--color-ink`, `--bg-elevated` became `--color-surface`, and the cyan it
 * spelled `#06b6d4` in six places is the accent — as `--color-accent-text`
 * where it colours letters (inline code, links) and `--color-accent` where it
 * only draws a rule, since the fill value is too dark to read on `surface`.
 */
.prose {
  color: var(--color-ink);
  line-height: 1.7;
  font-size: 0.95rem;
}
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3),
.prose :deep(h4) {
  font-family: var(--font-sans);
  font-weight: 600;
  color: var(--color-ink);
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}
.prose :deep(h1) { font-size: 1.5rem; }
.prose :deep(h2) {
  font-size: 1.2rem;
  border-bottom: 1px solid var(--color-line);
  padding-bottom: 0.3em;
}
.prose :deep(h3) { font-size: 1.05rem; }
.prose :deep(h4) { font-size: 0.95rem; }
.prose :deep(p) { margin-bottom: 0.9em; color: var(--color-ink-muted); }
.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 1.75em;
  margin-bottom: 0.9em;
  color: var(--color-ink-muted);
}
.prose :deep(ul) { list-style-type: disc; }
.prose :deep(ol) { list-style-type: decimal; }
.prose :deep(ul ul) { list-style-type: circle; }
.prose :deep(ul ul ul) { list-style-type: square; }
.prose :deep(li) { margin-bottom: 0.3em; display: list-item; }
.prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.82em;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: 3px;
  padding: 0.1em 0.4em;
  color: var(--color-accent-text);
}
.prose :deep(pre) {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: 1em 1.2em;
  overflow-x: auto;
  margin-bottom: 1em;
}
.prose :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-ink-muted);
  font-size: 0.85em;
}
.prose :deep(blockquote) {
  border-left: 3px solid var(--color-accent);
  margin: 1em 0;
  padding: 0.5em 1em;
  background: var(--color-surface);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  color: var(--color-ink-faint);
}
.prose :deep(a) { color: var(--color-accent-text); text-decoration: underline; }
/* Wide tables scroll rather than pushing the page sideways. */
.prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1em;
  font-size: 0.85em;
  display: block;
  overflow-x: auto;
}
.prose :deep(th),
.prose :deep(td) {
  border: 1px solid var(--color-line);
  padding: 0.4em 0.8em;
  text-align: left;
}
.prose :deep(th) {
  background: var(--color-surface);
  font-weight: 600;
  color: var(--color-ink);
}
.prose :deep(hr) { border: none; border-top: 1px solid var(--color-line); margin: 1.5em 0; }
.prose :deep(img) { max-width: 100%; }
</style>
