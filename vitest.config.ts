import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))
const plugin = (n: string) =>
  fileURLToPath(new URL(`./packages/plugins/${n}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@factory/events': src('events'),
      '@factory/core': src('core'),
      '@factory/store': src('store'),
      '@factory/engine': src('engine'),
      '@factory/config': src('config'),
      '@factory/plugin-sdk': src('plugin-sdk'),
      '@factory/runtime': src('runtime'),
      '@factory/mcp': src('mcp'),
      '@factory/provider-claude': plugin('provider-claude'),
      '@factory/provider-codex': plugin('provider-codex'),
      '@factory/provider-copilot': plugin('provider-copilot'),
      '@factory/task-terminal': plugin('task-terminal'),
      '@factory/task-session': plugin('task-session'),
      '@factory/task-diffity': plugin('task-diffity'),
    },
  },
  test: {
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
