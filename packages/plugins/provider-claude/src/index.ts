import { fileURLToPath } from 'node:url'
import { defineProviderPlugin } from '@factory/plugin-sdk'
import { claudeStream } from './stream.js'

/**
 * The claude provider. A descriptor and one call — see provider.yaml for the
 * flags, model roles and capabilities, all of which are data.
 *
 * The one exception is the reader for `--output-format stream-json`, because a
 * transcript format is a parser and a parser is not YAML. It is what makes a
 * refused *command* visible: without it the CLI exits 0 on a run where the
 * install never happened. `stream.ts` has the measured shapes.
 */
export default defineProviderPlugin({
  name: '@factory/provider-claude',
  version: '0.1.0',
  // src/ -> package root, and dist/ -> package root too.
  descriptorFile: fileURLToPath(new URL('../provider.yaml', import.meta.url)),
  stream: claudeStream,
})

export { claudeStream } from './stream.js'
