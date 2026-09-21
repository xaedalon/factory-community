import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { createBdd } from 'playwright-bdd'
import { test } from './fixtures.js'

const { Given, When, Then } = createBdd(test)

const WORKFLOW = 'name: development\nphases: [analysis]\n'
const PHASE = 'name: analysis\nsteps: [{run: echo hi}]\n'

Given('a project scope and a user scope', async ({ world }) => {
  world.createScopes()
})

Given('the project scope is empty', async () => {
  // Created by the Background; nothing further to do.
})

Given('the builtin scope is excluded', async ({ world }) => {
  world.excludeBuiltin = true
})

Given('the project defines the workflow {string}', async ({ world }, name: string) => {
  world.workflow(world.projectScope, name, WORKFLOW)
  world.phase(world.projectScope, 'analysis', PHASE)
})

Given('the user also defines the workflow {string}', async ({ world }, name: string) => {
  world.workflow(world.userScope, name, 'name: development\ndescription: mine\nphases: []\n')
})

Given('the project defines a broken workflow {string}', async ({ world }, name: string) => {
  world.workflow(world.projectScope, name, `name: ${name}\nmode: banana\nphases: []\n`)
})

Given('the project defines the phase {string}', async ({ world }, name: string) => {
  world.phase(world.projectScope, name, PHASE)
})

Given('the daemon is not running', async ({ world }) => {
  world.disabled = true
})

When('I open the workflows page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/workflows')
})

When('I open the phases page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/phases')
})

When('I open the scopes page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/scopes')
})

When('I open the plugins page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/plugins')
})

Then('the workflow {string} is listed', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`)).toBeVisible()
})

Then('the phase {string} is listed', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`)).toBeVisible()
})

Then('the workflow {string} is listed once', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`)).toHaveCount(1)
})

Then('{string} shows the project scope', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`).getByTestId('scope-project')).toBeVisible()
})

Then('{string} shows the builtin scope', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`).getByTestId('scope-builtin')).toBeVisible()
})

Then('{string} is marked as hiding the user scope', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`).getByTestId('shadow-notice')).toContainText('user')
})

Then('{string} is flagged as not validating', async ({ page }, name: string) => {
  await expect(page.getByTestId(`invalid-${name}`)).toBeVisible()
})

Then('the page says there is nothing yet', async ({ page }) => {
  await expect(page.getByTestId('empty')).toBeVisible()
})

Then('the scope chain is {string}', async ({ page }, chain: string) => {
  const kinds = chain.split(', ')
  const rows = page.getByTestId('scope-chain').locator('li')
  await expect(rows).toHaveCount(kinds.length)
  for (const [index, kind] of kinds.entries()) {
    await expect(rows.nth(index)).toHaveAttribute('data-testid', `scope-row-${kind}`)
  }
})

Then('the builtin scope is shown as read-only', async ({ page }) => {
  await expect(page.getByTestId('scope-row-builtin')).toContainText('read-only')
})

Then('the page says new definitions go to the project scope', async ({ page }) => {
  await expect(page.getByTestId('write-target')).toContainText('project')
})

Then('{string} is listed as an agent', async ({ page }, id: string) => {
  await expect(page.getByTestId(`provider-${id}`)).toBeVisible()
})

Then('{string} is marked as having an unverified descriptor', async ({ page }, id: string) => {
  await expect(page.getByTestId(`provisional-${id}`)).toBeVisible()
})

Then('the step kinds include {string}', async ({ page }, id: string) => {
  // Grouped by the plugin that provided it rather than by kind, which is the
  // question the page now answers: which plugin gave me this, and is it on.
  await expect(page.getByTestId('plugin-@factory/core/builtin-steps')).toContainText(
    `step-kind:${id}`,
  )
})

Then('the page says it cannot reach the daemon', async ({ page }) => {
  await expect(page.getByTestId('error')).toContainText('Cannot reach the Factory daemon')
})

// ---------------------------------------------------------------- builder

Given('the user defines the workflow {string}', async ({ world }, name: string) => {
  world.workflow(world.userScope, name, `name: ${name}\nphases: []\n`)
})

Given('the project scope has no workflow {string}', async ({ world }, name: string) => {
  // A precondition worth actually checking rather than assuming: the scenario
  // is about shadowing, which only means anything if the target is empty.
  expect(existsSync(join(world.projectScope, 'workflows', `${name}.workflow.yaml`))).toBe(false)
})

Given(
  'a plugin provides a {string} step kind requiring a {string}',
  async ({ world }, kind: string, field: string) => {
    world.httpPlugin(kind, field)
  },
)

When('I open the new workflow page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/workflows/new')
  await expect(page.getByTestId('scope-selector')).toBeVisible()
})

When('I open the new phase page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/phases/new')
  await expect(page.getByTestId('scope-selector')).toBeVisible()
})

When('I open the workflow {string}', async ({ world, page }, name: string) => {
  await world.startDaemon()
  await page.goto(`/workflows/${name}`)
  await expect(page.getByTestId('scope-selector')).toBeVisible()
})

When('I open the workflows list', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/workflows')
  await expect(page.getByTestId('workflow-table-yours')).toBeVisible()
})

Then('{string} is under {string}', async ({ page }, name: string, group: string) => {
  const table = group === 'Built in' ? 'workflow-table-builtin' : 'workflow-table-yours'
  await expect(page.getByTestId(table).getByTestId(`row-${name}`)).toBeVisible()
})

Then('there is no repeat field', async ({ page }) => {
  await expect(page.getByTestId('wf-repeat')).toHaveCount(0)
})

Then('the repeat field is offered', async ({ page }) => {
  await expect(page.getByTestId('wf-repeat')).toBeVisible()
})

When('I set the repeat to {string}', async ({ page }, value: string) => {
  await page.getByTestId('wf-repeat').fill(value)
  await page.getByTestId('wf-repeat').blur()
})

Then('the preview says the repeat is {int}', async ({ page }, value: number) => {
  await expect(page.getByTestId('yaml-preview')).toContainText(`repeat: ${value}`)
})

Then('the phases field has a visible arrow', async ({ page }) => {
  // Not "is it a datalist" — whether a person can see that it opens one. The
  // native indicator is invisible until hover, so the control draws its own.
  const drawn = await page
    .getByTestId('phases-input')
    .evaluate((node) => getComputedStyle(node).backgroundImage)
  expect(drawn).toContain('url(')
})

Then('the phases field offers the phases that exist', async ({ page }) => {
  const options = await page
    .getByTestId('phases-input-options')
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
  expect(options).toContain('greet')
})

When('I set the name to {string}', async ({ page }, value: string) => {
  await page.locator('#wf-name, #ph-name').first().fill(value)
})

When('I set the description to {string}', async ({ page }, value: string) => {
  await page.locator('#wf-description, #ph-description').first().fill(value)
})

When('I set the mode to {string}', async ({ page }, value: string) => {
  await page.getByLabel('Mode').selectOption(value)
})

When('I set scheduling to {string}', async ({ page }, value: string) => {
  await page.getByLabel('Scheduling').selectOption(value)
})

When('I add the phase {string}', async ({ page }, name: string) => {
  await page.getByTestId('phases-input').fill(name)
  await page.getByTestId('phases-add').click()
})

When('I require the condition {string}', async ({ page }, flag: string) => {
  await page.getByTestId('requires-input').fill(flag)
  await page.getByTestId('requires-add').click()
})

When('I add a step', async ({ page }) => {
  await page.getByTestId('step-add').click()
})

When('I set the step kind to {string}', async ({ page }, kind: string) => {
  await page.getByTestId('step-0-uses').selectOption(kind)
})

When('I add a step running {string}', async ({ page }, command: string) => {
  const before = await page.locator('[data-testid^="step-"][data-testid$="-toggle"]').count()
  await page.getByTestId('step-add').click()
  await page.getByTestId(`step-${before}`).getByTestId('field-run').fill(command)
})

When('I move the second step up', async ({ page }) => {
  await page.getByTestId('step-1-up').click()
})

When('I save', async ({ page }) => {
  await page.getByTestId('save').click()
})

Then('the scope selector offers {string}', async ({ page }, scope: string) => {
  await expect(page.getByTestId(`scope-option-${scope}`)).toBeEnabled()
})

Then('the target path is shown in full', async ({ page }) => {
  await expect(page.getByTestId('scope-path')).toContainText('.xaedalon/.factory')
})

Then('the builtin scope cannot be chosen', async ({ page }) => {
  await expect(page.getByTestId('scope-option-builtin')).toBeDisabled()
})

Then('the preview contains {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('yaml-preview')).toContainText(text)
})

Then('there is no interval field', async ({ page }) => {
  await expect(page.getByLabel('Interval')).toHaveCount(0)
})

Then('there is an interval field', async ({ page }) => {
  await expect(page.getByLabel('Interval')).toBeVisible()
})

Then('I am back on the workflows list', async ({ page }) => {
  await expect(page).toHaveURL(/\/workflows$/)
})

Then('I am back on the phases list', async ({ page }) => {
  await expect(page).toHaveURL(/\/phases$/)
})

Then('the problem names the field {string}', async ({ page }, field: string) => {
  await expect(page.getByTestId('problems')).toContainText(field)
})

Then('the name field reads {string}', async ({ page }, value: string) => {
  await expect(page.locator('#wf-name, #ph-name').first()).toHaveValue(value)
})

Then('I am warned that saving will hide the user copy', async ({ page }) => {
  await expect(page.getByTestId('will-shadow')).toContainText('user')
})

Then('the target scope is not builtin', async ({ page }) => {
  await expect(page.getByTestId('scope-path')).not.toContainText('packages/core/builtin')
})

Then('I am offered to fork it to a writable scope', async ({ page }) => {
  await expect(page.getByTestId('fork-to-project')).toBeVisible()
})

Then('the step kind can be chosen from the registry', async ({ page }) => {
  const options = page.getByTestId('step-0-uses').locator('option')
  await expect(options).toContainText(['shell'])
  await expect(options).toContainText(['agent'])
})

Then('the shell step shows a {string} field', async ({ page }, field: string) => {
  await expect(page.getByTestId(`step-0`).getByTestId(`field-${field}`)).toBeVisible()
})

Then('the step shows a {string} field', async ({ page }, field: string) => {
  await expect(page.getByTestId('step-0').getByTestId(`field-${field}`)).toBeVisible()
})

Then(
  'the step shows a {string} field offering {string}',
  async ({ page }, field: string, option: string) => {
    const select = page.getByTestId('step-0').getByTestId(`field-${field}`)
    await expect(select.locator('option')).toContainText([option])
  },
)

Then('the step is marked as not runnable', async ({ page }) => {
  await expect(page.getByTestId('step-0-not-runnable')).toBeVisible()
})

Then('the preview lists {string} before {string}', async ({ page }, first: string, second: string) => {
  const preview = page.getByTestId('yaml-preview')
  // Wait for both to arrive before comparing positions. The preview is
  // debounced and rendered by the daemon, so a one-shot textContent() reads
  // whatever happened to be on screen — which is how this assertion failed
  // against a preview that was simply a beat behind.
  await expect(preview).toContainText(first)
  await expect(preview).toContainText(second)
  const text = (await preview.textContent()) ?? ''
  expect(text.indexOf(first)).toBeLessThan(text.indexOf(second))
})

// ---------------------------------------------------------------- authoring

When('I switch to the YAML view', async ({ page }) => {
  await page.getByTestId('view-yaml').click()
})

When('I switch back to the form view', async ({ page }) => {
  await page.getByTestId('view-form').click()
})

When('I follow the offer to create it', async ({ page, context, world }) => {
  const popup = context.waitForEvent('page')
  await page.getByTestId('phase-nowhere-create').click()
  world.openedTab = await popup
  await world.openedTab.waitForLoadState()
})

When('I delete it', async ({ page }) => {
  await page.getByTestId('delete').click()
  await page.getByTestId('delete-confirm').click()
})

When('someone else changes the file', async ({ world }) => {
  // Edited underneath the open editor, exactly as a terminal or another tab
  // would: the content changes, so the etag the page is holding goes stale.
  world.workflow(
    world.projectScope,
    'development',
    'name: development\ndescription: theirs\nphases: []\n',
  )
})

When('I choose to discard mine and reload', async ({ page }) => {
  await page.getByTestId('conflict-reload').click()
})

When('I choose to overwrite', async ({ page }) => {
  await page.getByTestId('conflict-overwrite').click()
})

Then('the file is shown', async ({ page }) => {
  await expect(page.getByTestId('yaml-preview')).toBeVisible()
})

Then('the form is not shown', async ({ page }) => {
  await expect(page.getByTestId('scope-selector')).toHaveCount(0)
})

Then('the form is shown', async ({ page }) => {
  await expect(page.getByTestId('scope-selector')).toBeVisible()
})

Then('{string} is flagged as missing', async ({ page }, name: string) => {
  await expect(page.getByTestId(`phase-${name}-missing`)).toBeVisible()
})

Then('I am offered to create it', async ({ page }) => {
  await expect(page.getByTestId('phase-nowhere-create')).toBeVisible()
})

Then('the phase reference {string} shows the project scope', async ({ page }, name: string) => {
  await expect(page.getByTestId(`phase-${name}`).getByTestId('scope-project')).toBeVisible()
})

Then('the new phase page opens in a new tab', async ({ world }) => {
  await expect(world.openedTab!).toHaveURL(/\/phases\/new/)
})

Then('the name field there reads {string}', async ({ world }, value: string) => {
  await expect(world.openedTab!.locator('#ph-name')).toHaveValue(value)
})

Then('the workflow I was editing is still open', async ({ page }) => {
  await expect(page).toHaveURL(/\/workflows\/development/)
  await expect(page.getByTestId('phase-nowhere')).toBeVisible()
})

Then('the workflows list is open', async ({ page }) => {
  // An editor for a definition that no longer exists has nothing to edit.
  await expect(page).toHaveURL(/\/workflows(\?|$)/)
})

Then('it says the workflow was deleted', async ({ page }) => {
  await expect(page.getByTestId('deleted')).toBeVisible()
})

Then('it says the name still resolves from a lower scope', async ({ page }) => {
  await expect(page.getByTestId('deleted-revealed')).toContainText('user')
})

Then('the delete button asks for confirmation before doing anything', async ({ page }) => {
  await page.getByTestId('delete').click()
  await expect(page.getByTestId('delete-confirm')).toBeVisible()
})

Then('there is no delete button', async ({ page }) => {
  await expect(page.getByTestId('delete')).toHaveCount(0)
})

Then('I am told the file changed on disk', async ({ page }) => {
  await expect(page.getByTestId('conflict')).toBeVisible()
})

Then('I am shown what is there now', async ({ page }) => {
  await expect(page.getByTestId('conflict-current')).toContainText('theirs')
})

Then('nothing was written', async ({ world }) => {
  const text = readFileSync(
    join(world.projectScope, 'workflows', 'development.workflow.yaml'),
    'utf8',
  )
  expect(text).toContain('theirs')
  expect(text).not.toContain('Mine.')
})

Then('the description field reads {string}', async ({ page }, value: string) => {
  await expect(page.locator('#wf-description')).toHaveValue(value)
})

Then('the stored workflow says {string}', async ({ world }, value: string) => {
  const text = readFileSync(
    join(world.projectScope, 'workflows', 'development.workflow.yaml'),
    'utf8',
  )
  expect(text).toContain(value)
})

// ---------------------------------------------------------------- sharing

Given("the project's own copy is removed", async ({ world }) => {
  // Shadowing needs the *target* free and a lower scope occupied. With the
  // project copy still present this would be an ordinary conflict.
  rmSync(join(world.projectScope, 'workflows', 'development.workflow.yaml'))
})

Given('the phase it needs is deleted', async ({ world }) => {
  rmSync(join(world.projectScope, 'phases', 'analysis.phase.yaml'))
})

Given('a bundle for the workflow {string}', async ({ world }, name: string) => {
  // Produced by the daemon's own exporter rather than hand-written, so the
  // scenario exercises a real bundle and not a guess at the shape of one.
  world.workflow(world.projectScope, name, WORKFLOW)
  world.phase(world.projectScope, 'analysis', PHASE)
  await world.startDaemon()
  const response = await fetch(world.api(`/api/workflows/${name}/export`), {
    method: 'POST',
  })
  world.bundle = ((await response.json()) as { text: string }).text
})

Given('the user already defines the workflow {string}', async ({ world }, name: string) => {
  world.workflow(world.userScope, name, `name: ${name}\ndescription: mine\nphases: []\n`)
})

When('I open the import page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/bundles/import')
  await expect(page.getByTestId('bundle-text')).toBeVisible()
})

When('I paste the bundle', async ({ world, page }) => {
  await page.getByTestId('bundle-text').fill(world.bundle)
})

When('I paste a document that is not a bundle', async ({ page }) => {
  await page.getByTestId('bundle-text').fill('kind: factory.workflow/v1\nname: development\n')
})

When('I choose the {word} scope', async ({ page }, scope: string) => {
  await page.locator('#import-scope').selectOption(scope)
})

When('I set the conflict policy to {string}', async ({ page }, policy: string) => {
  await page.locator('#import-policy').selectOption(policy)
})

When('I set the prefix to {string}', async ({ page }, prefix: string) => {
  await page.locator('#import-prefix').fill(prefix)
})

When('I import', async ({ page }) => {
  await page.getByTestId('import-apply').click()
})

When('I export {string}', async ({ world, page }, name: string) => {
  // Short timeout on purpose: an export that is refused never produces a
  // download, and waiting the full test budget for one turns a clear failure
  // into a timeout reported against whatever step came next.
  const pending = page.waitForEvent('download', { timeout: 3000 }).catch(() => undefined)
  await page.getByTestId(`export-${name}`).click()
  const download = await pending
  if (download !== undefined) {
    const path = await download.path()
    world.bundle = readFileSync(path, 'utf8')
  }
})

Then('a bundle file is downloaded', async ({ world }) => {
  expect(world.bundle).toContain('kind: factory.bundle/v1')
})

Then('the bundle contains the phase {string}', async ({ world }, name: string) => {
  expect(world.bundle).toContain(`name: ${name}`)
})

Then('the export is refused', async ({ page }) => {
  await expect(page.getByTestId('export-error')).toBeVisible()
})

Then('the reason names the missing phase', async ({ page }) => {
  await expect(page.getByTestId('export-error')).toContainText('analysis')
})

Then('the plan says {string} would be created', async ({ page }, name: string) => {
  await expect(page.getByTestId(`plan-${name}`)).toContainText('create')
})

Then('the plan says {string} would be skipped', async ({ page }, name: string) => {
  await expect(page.getByTestId(`plan-${name}`)).toContainText('skip')
})

Then('the plan marks {string} as a conflict', async ({ page }, name: string) => {
  await expect(page.getByTestId(`plan-${name}`)).toContainText('conflict')
})

Then('the plan says it was renamed from {string}', async ({ page }, name: string) => {
  await expect(page.getByTestId('plan-acme-development-renamed')).toContainText(name)
})

Then('the plan says {string} will hide the user copy', async ({ page }, name: string) => {
  await expect(page.getByTestId(`plan-${name}-shadows`)).toContainText('user')
})

Then('nothing has been written yet', async ({ world }) => {
  expect(existsSync(join(world.userScope, 'workflows', 'development.workflow.yaml'))).toBe(false)
})

Then('it says the files were written', async ({ page }) => {
  await expect(page.getByTestId('imported')).toBeVisible()
})

Then('the user scope has the workflow {string}', async ({ world }, name: string) => {
  expect(existsSync(join(world.userScope, 'workflows', `${name}.workflow.yaml`))).toBe(true)
})

Then('the import cannot proceed', async ({ page }) => {
  await expect(page.getByTestId('import-apply')).toBeDisabled()
})

Then('the import can proceed', async ({ page }) => {
  await expect(page.getByTestId('import-apply')).toBeEnabled()
})

Then('I am told how to resolve it', async ({ page }) => {
  await expect(page.getByTestId('import-problems')).toContainText('--prefix')
})

Then('the import is refused', async ({ page }) => {
  await expect(page.getByTestId('import-problems')).toBeVisible()
})

Then('I am told it is not a bundle', async ({ page }) => {
  await expect(page.getByTestId('import-problems')).toContainText('not a Factory bundle')
})

/* ------------------------------------------------------------------ tasks */

const HELLO_WORKFLOW = 'name: hello\nphases: [greet]\n'
const HELLO_PHASE = 'name: greet\nsteps: [{run: echo hello}]\n'

Given(
  'the project defines the workflow {string} that prints {string}',
  async ({ world }, name: string, text: string) => {
    world.workflow(world.projectScope, name, HELLO_WORKFLOW.replace('hello', name))
    world.phase(world.projectScope, 'greet', HELLO_PHASE.replace('hello', text))
    // Anything that queues a task needs a shell to run it with.
    world.withShell = true
  },
)

Given('the task {string} exists on {string}', async ({ world }, name: string, workflow: string) => {
  await world.startDaemon()
  await world.createTask(name, [workflow])
})

When('I open the tasks page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/tasks')
})

When(
  'I create the task {string} on {string}',
  async ({ page }, name: string, workflow: string) => {
    await page.getByTestId('new-task').click()
    await page.getByTestId('task-name').fill(name)
    await page.getByTestId(`pick-workflow-${workflow}`).click()
    await page.getByTestId('create-task').click()
  },
)

When('I create the task {string} with no workflow', async ({ page }, name: string) => {
  await page.getByTestId('new-task').click()
  await page.getByTestId('task-name').fill(name)
  await page.getByTestId('create-task').click()
})

// Creating a task lands on the task, which is the next thing you want to look
// at. Coming back is a separate move, and the scenarios say so.
When('I go back to the board', async ({ page }) => {
  await page.getByTestId('nav-tasks').click()
})

Then('the task page for {string} opens', async ({ page }, name: string) => {
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{8}/)
  await expect(page.getByRole('heading', { name })).toBeVisible()
})

When('I filter by the status {string}', async ({ page }, label: string) => {
  await page.getByTestId('filter-state').selectOption({ label })
})

When('I switch to the board view', async ({ page }) => {
  await page.getByTestId('view-board').click()
})

When('I queue {string}', async ({ page }, name: string) => {
  await page.getByTestId(`task-row-${name}`).getByTestId('action-queue').click()
})

When('I open {string}', async ({ page }, name: string) => {
  await page.getByTestId(`open-${name}`).click()
})

Then('the board says there is nothing yet', async ({ page }) => {
  await expect(page.getByTestId('tasks-empty')).toBeVisible()
})

Then('{string} is on the board', async ({ page }, name: string) => {
  await expect(page.getByTestId(`task-row-${name}`)).toBeVisible()
})

Then('{string} is {string}', async ({ page }, name: string, state: string) => {
  await expect(
    page.getByTestId(`task-row-${name}`).getByTestId(`state-${state}`),
  ).toBeVisible()
})

Then('{string} offers {string}', async ({ page }, name: string, label: string) => {
  await expect(
    page.getByTestId(`task-row-${name}`).getByRole('button', { name: label }),
  ).toBeVisible()
})

Then('{string} does not offer {string}', async ({ page }, name: string, label: string) => {
  await expect(
    page.getByTestId(`task-row-${name}`).getByRole('button', { name: label }),
  ).toHaveCount(0)
})

Then('the board counts {int} task in total', async ({ page }, total: number) => {
  await expect(page.getByTestId('summary-total')).toContainText(String(total))
})

Then('the card for {string} says {string}', async ({ page }, name: string, text: string) => {
  await expect(page.getByTestId(`card-progress-${name}`)).toContainText(text, { timeout: 15_000 })
})

/**
 * The width, not the presence.
 *
 * A bar rendered at 0% and a bar that was never drawn look identical on
 * screen, so asserting it exists would pass on either.
 *
 * Matched inside the attribute rather than against the whole of it. The bar
 * also carries the state's colour now, and an equality check on `style` made
 * this step fail over a second declaration it was never about.
 */
Then('its bar is {int}% full', async ({ page }, percent: number) => {
  await expect(page.getByTestId(/^card-progress-fill-/)).toHaveAttribute(
    'style',
    new RegExp(`(^|;)\\s*width:\\s*${percent}%\\s*(;|$)`),
  )
})

Then('{string} is in the {string} column', async ({ page }, name: string, column: string) => {
  await expect(page.getByTestId(`column-${column}`).getByTestId(`card-${name}`)).toBeVisible()
})

/**
 * The point of the live stream: no reload, no polling in the test either.
 * Playwright's auto-waiting is doing the same job a person would — watching the
 * page until it says what it should.
 */
Then(
  '{string} becomes {string} without me reloading',
  async ({ page }, name: string, state: string) => {
    await expect(
      page.getByTestId(`task-row-${name}`).getByTestId(`state-${state}`),
    ).toBeVisible({ timeout: 20_000 })
  },
)

Then('the run for {string} is listed', async ({ page }, workflow: string) => {
  await expect(page.getByTestId(`run-${workflow}-1`)).toBeVisible()
})

Then('the step {string} is listed', async ({ page }, describe: string) => {
  await expect(page.getByTestId(`step-${describe}`)).toBeVisible()
})

Then('opening the step shows {string}', async ({ page }, text: string) => {
  await page.getByTestId(`step-echo ${text}`).click()
  await expect(page.getByTestId(`log-echo ${text}`)).toContainText(text)
})

/* --------------------------------------------------------------- projects */

Given('the project {string} is registered', async ({ world }, name: string) => {
  await world.startDaemon()
  await world.addProject(name, world.workDir)
})

When('I open the projects page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/projects')
})

// Adding is a page of its own now, reached from the list the same way a
// person reaches it. The steps go through the button rather than jumping to
// the URL, so a broken route fails here rather than silently passing.
When(
  'I add the project {string} at the project directory',
  async ({ world, page }, name: string) => {
    await page.getByTestId('new-project').click()
    await page.getByTestId('project-name').fill(name)
    await page.getByTestId('project-path').fill(world.workDir)
    await page.getByTestId('save-project').click()
  },
)

When(
  'I add the project {string} at a path that does not exist',
  async ({ world, page }, name: string) => {
    await page.getByTestId('new-project').click()
    await page.getByTestId('project-name').fill(name)
    await page.getByTestId('project-path').fill(`${world.root}/nowhere`)
    await page.getByTestId('save-project').click()
  },
)

When(
  'I create the task {string} in {string} on {string}',
  async ({ page }, name: string, project: string, workflow: string) => {
    await page.getByTestId('new-task').click()
    await page.getByTestId('task-name').fill(name)
    await page.getByTestId('task-project').selectOption({ label: project })
    await page.getByTestId(`pick-workflow-${workflow}`).click()
    await page.getByTestId('create-task').click()
  },
)

Then('{string} is listed as a project', async ({ page }, name: string) => {
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
})

When('I open the project {string}', async ({ page }, name: string) => {
  await page.getByTestId(`open-project-${name}`).click()
  await expect(page.getByTestId('project-form')).toBeVisible()
})

When('I rename the project to {string}', async ({ page }, to: string) => {
  await page.getByTestId('project-name').fill(to)
  await page.getByTestId('save-project').click()
})

When('I point it at the branch {string}', async ({ page }, branch: string) => {
  await page.getByTestId('project-branch').fill(branch)
  await page.getByTestId('save-project').click()
})

Then('{string} starts work from {string}', async ({ page }, name: string, branch: string) => {
  await expect(page.getByTestId(`project-${name}`)).toContainText(branch)
})

/**
 * The list is a list.
 *
 * Asserting the absence of the old controls rather than the presence of the new
 * ones: the failure this guards against is somebody adding a convenient toggle
 * back into a row, which no positive assertion would ever notice.
 */
Then('no project setting can be changed from the list', async ({ page }) => {
  await expect(page.getByTestId('add-project')).toHaveCount(0)
  await expect(page.getByTestId(/^toggle-worktrees-/)).toHaveCount(0)
  await expect(page.getByTestId(/^toggle-environments-/)).toHaveCount(0)
  await expect(page.getByTestId(/^profile-/)).toHaveCount(0)
  await expect(page.getByTestId(/^remove-/)).toHaveCount(0)
})

Then('the name field explains what it is for', async ({ page }) => {
  await expect(page.getByText('The rail derives its square')).toBeVisible()
})

Then('the path is shown as fixed', async ({ page }) => {
  await expect(page.getByTestId('project-path-fixed')).toBeVisible()
  await expect(page.getByTestId('project-path')).toHaveCount(0)
})

Then('the name field says the name is taken', async ({ page }) => {
  await expect(page.getByTestId('field-error-name')).toContainText('already exists')
})

When('I press remove once', async ({ page }) => {
  await page.getByTestId('remove-project').click()
})

Then('the project is still there', async ({ page }) => {
  await expect(page.getByTestId('remove-project-confirm')).toBeVisible()
  await expect(page.getByTestId('project-form')).toBeVisible()
})

When('I confirm the removal', async ({ page }) => {
  await page.getByTestId('remove-project-confirm').click()
})

Then('no projects are listed', async ({ page }) => {
  await expect(page.getByTestId('projects-empty')).toBeVisible()
})

// Against the path box, not in a banner at the top of the form. A refusal that
// does not say which field it means makes you check all of them.
Then('the page explains that there is nothing at that path', async ({ page }) => {
  await expect(page.getByTestId('field-error-path')).toContainText('there is nothing at')
})

Then('{string} shows the project {string}', async ({ page }, task: string, project: string) => {
  await expect(page.getByTestId(`task-row-${task}`)).toContainText(project)
})

/* -------------------------------------------------------------- evidence */

Given(
  'the project defines the workflow {string} that writes a report and asks for approval',
  async ({ world }, name: string) => {
    world.workflow(world.projectScope, name, `name: ${name}\nphases: [report]\n`)
    // An agent step, because an artifact belongs to one: it is the only kind
    // that can be told where to write. `provider` is named because three are
    // installed and an unnamed step would be ambiguous.
    world.phase(
      world.projectScope,
      'report',
      [
        'name: report',
        'approval: required',
        'steps: [{uses: agent, provider: claude, artifact: report, prompt: Review it}]',
        '',
      ].join('\n'),
    )
    world.withStubAgent = true
  },
)

Given('the report it writes is a Markdown document', async ({ world }) => {
  world.stubArtifact = [
    '# Review',
    '',
    '## Findings',
    '',
    '- one thing',
    '- another',
    '',
    '`inline code`',
  ].join('\n')
})

Given('the report it writes tries to run something', async ({ world }) => {
  // What a model quoting a bug report might plausibly emit.
  world.stubArtifact = [
    '# Review',
    '',
    '<img src=x onerror="window.__ran = true">',
    '',
    'the surrounding prose',
  ].join('\n')
})

Then('{string} is listed as an artifact', async ({ page }, name: string) => {
  await expect(page.getByTestId(`artifact-${name}`)).toBeVisible()
})

When('I open the artifact {string}', async ({ page }, name: string) => {
  await page.getByTestId(`artifact-${name}`).click()
  await expect(page.getByTestId('artifact-path')).toBeVisible()
})

Then('the artifact page shows its path', async ({ page }) => {
  await expect(page.getByTestId('artifact-path')).toContainText('artifacts/report/report.md')
})

Then('{string} is a heading', async ({ page }, text: string) => {
  // By role: that it *is* a heading is the claim, not that the text appears.
  await expect(page.getByRole('heading', { name: text })).toBeVisible()
})

Then('the source markup is not on screen', async ({ page }) => {
  await expect(page.getByTestId('artifact-content')).not.toContainText('## Findings')
})

Then('the path in the evidence header opens {string}', async ({ page }, name: string) => {
  await page.getByTestId(`evidence-${name}-open`).click()
  await expect(page.getByTestId('artifact-path')).toBeVisible()
})

Then('nothing on the page can run', async ({ page }) => {
  // The attribute is gone, and it never fired: DOMPurify strips it before the
  // markup is ever set, so there is no window in which it could have.
  await expect(page.locator('[onerror]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined()
})

Then('the text around it is still shown', async ({ page }) => {
  await expect(page.getByTestId('artifact-content')).toContainText('the surrounding prose')
})

Then('the evidence from {string} is shown', async ({ page }, name: string) => {
  await expect(page.getByTestId(`evidence-${name}`)).toBeVisible()
})

Then('the evidence reads {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('evidence')).toContainText(text)
})

When('I approve it', async ({ page }) => {
  await page.getByTestId('action-approve').click()
})

Then('the task finishes', async ({ page }) => {
  // Nothing else pushes it: approving puts the task back in front of the
  // scheduler, which resumes the paused run from the phase after the gate.
  await expect(page.getByTestId('state-done')).toBeVisible({ timeout: 20_000 })
})

/* ------------------------------------------------------------------ setup */

When('I open the setup page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/setup')
})

Then('{string} is a setup step', async ({ page }, title: string) => {
  await expect(page.getByTestId('setup-steps')).toContainText(title)
})

Then('it is marked essential', async ({ page }) => {
  await expect(page.getByTestId('step-a-project')).toContainText('essential')
})

Then('the page says Factory cannot run work yet', async ({ page }) => {
  await expect(page.getByTestId('setup-summary')).toContainText('cannot run work yet')
})

Then('a setup step offers a command to copy', async ({ page }) => {
  // The command, not a URL. This asserted `api/projects` until the hint stopped
  // being a curl against a hardcoded port — see the engine's own scenario, "its
  // terminal hint is a command, not a port" (packages/engine/features/doctor.feature).
  // The two suites asserted opposite things for two days, and the browser one
  // was the stale half.
  await expect(page.getByTestId('command-a-project-1')).toContainText('factory project add')
})

When(
  'I add the project {string} at the project directory, without worktrees',
  async ({ world, page }, name: string) => {
    await page.getByTestId('new-project').click()
    await page.getByTestId('project-name').fill(name)
    await page.getByTestId('project-path').fill(world.workDir)
    // The switch is a real checkbox behind a drawn one, so `uncheck` still
    // works and the keyboard still does.
    await page.getByTestId('project-worktrees-field').getByRole('checkbox').uncheck()
    await page.getByTestId('save-project').click()
  },
)

When('I switch {string} to working in the repository', async ({ page }, name: string) => {
  await page.getByTestId(`open-project-${name}`).click()
  await page.getByTestId('project-worktrees-field').getByRole('checkbox').uncheck()
  await page.getByTestId('save-project').click()
})

Then(
  '{string} says it works in the repository, one task at a time',
  async ({ page }, name: string) => {
    await expect(page.getByTestId(`shared-checkout-${name}`)).toBeVisible()
  },
)

/* ------------------------------------------------------------------- rail */

Given(
  'a second project {string} that defines the workflow {string}',
  async ({ world }, project: string, workflow: string) => {
    // Its own repository, with its own `.factory` — the daemon is started in
    // `workDir`, so anything this project can see, it can see because it is
    // the project, not because of where the daemon was launched.
    world.createOtherScope()
    world.workflow(world.otherScope, workflow, `name: ${workflow}\nphases: []\n`)
    await world.startDaemon()
    await world.addProject(project, world.otherDir)
  },
)

Given(
  'the task {string} exists in {string} on {string}',
  async ({ world }, name: string, project: string, workflow: string) => {
    await world.startDaemon()
    await world.createTask(name, [workflow], world.projectIds.get(project))
  },
)

When('I choose the project {string}', async ({ page }, name: string) => {
  await page.getByTestId(`project-button-${name}`).click()
})

When('I choose every project', async ({ page }) => {
  await page.getByTestId('project-button-all').click()
})

When('I reload the page', async ({ page }) => {
  await page.reload()
})

Then('the rail offers {string}', async ({ page }, name: string) => {
  await expect(page.getByTestId(`project-button-${name}`)).toBeVisible()
})

Then('the board is showing every project', async ({ page }) => {
  await expect(page.getByTestId('project-button-all')).toHaveAttribute('aria-current', 'true')
})

Then('{string} is not on the board', async ({ page }, name: string) => {
  await expect(page.getByTestId(`task-row-${name}`)).toHaveCount(0)
})

Then('the workflow {string} is not listed', async ({ page }, name: string) => {
  await expect(page.getByTestId(`row-${name}`)).toHaveCount(0)
})

/**
 * The colour is read off the rendered element rather than recomputed here.
 *
 * Asserting that the browser shows the same thing twice is the claim; a second
 * copy of the hashing in the test would agree with itself whatever the page did.
 */
let remembered = ''

When('I remember the colour of {string}', async ({ page }, name: string) => {
  remembered = await page
    .getByTestId(`project-button-${name}`)
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  // It has to actually have one. Comparing two transparent squares passes
  // happily and proves nothing — which is exactly what this step did until a
  // screenshot showed the palette had been tree-shaken out of the stylesheet.
  expect(remembered).not.toBe('rgba(0, 0, 0, 0)')
  expect(remembered).not.toBe('transparent')
})

Then('{string} is the same colour', async ({ page }, name: string) => {
  await expect(page.getByTestId(`project-button-${name}`)).toHaveCSS(
    'background-color',
    remembered,
  )
})

/* -------------------------------------------------------- the task's plan */

When('I start a new task', async ({ page }) => {
  await page.getByTestId('new-task').click()
})

When('I start a new task from the board', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/tasks')
  await page.getByTestId('new-task').click()
})

Then('the new task page is open', async ({ page }) => {
  await expect(page).toHaveURL(/\/tasks\/new$/)
  await expect(page.getByTestId('new-task-form')).toBeVisible()
})

When('I add the workflow {string}', async ({ page }, name: string) => {
  await page.getByTestId(`pick-workflow-${name}`).click()
})

/**
 * Both clicks in one tick, which a person cannot quite manage and a script can.
 *
 * Worth a scenario because the failure is silent: each handler read the list
 * before changing it, so the second change started from the same array as the
 * first and quietly threw it away. Ordinary Playwright clicks are far enough
 * apart that Vue re-renders in between and the bug never shows.
 */
When('I add {string} and {string} in the same instant', async ({ page }, a: string, b: string) => {
  // Both buttons have to be on the page before the clicks, and the clicks have
  // to fail loudly if they are not. `?.click()` on a button that has not
  // rendered is a step that silently does nothing — which is exactly how this
  // scenario passed here and failed on CI's slower machine, reporting an empty
  // list rather than a lost click.
  await expect(page.getByTestId(`pick-workflow-${a}`)).toBeVisible()
  await expect(page.getByTestId(`pick-workflow-${b}`)).toBeVisible()
  await page.evaluate(
    ([first, second]) => {
      const one = document.querySelector<HTMLElement>(`[data-testid="pick-workflow-${first}"]`)
      const two = document.querySelector<HTMLElement>(`[data-testid="pick-workflow-${second}"]`)
      if (one === null || two === null) {
        throw new Error(`Both buttons must exist: ${first} ${one === null ? 'missing' : 'ok'}, ${second} ${two === null ? 'missing' : 'ok'}.`)
      }
      // One tick, no await between them: that is the whole point.
      one.click()
      two.click()
    },
    [a, b],
  )
})

When('I move the second workflow up', async ({ page }) => {
  await page.getByTestId('workflow-1-up').click()
})

When('I remove the first workflow', async ({ page }) => {
  await page.getByTestId('workflow-0-remove').click()
})

When('I save the workflows', async ({ page }) => {
  await page.getByTestId('save-workflows').click()
})

Then('the workflows are {string}', async ({ page }, expected: string) => {
  const names = expected.split(', ')
  const rows = page.getByTestId('chosen-workflows').locator('li')
  await expect(rows).toHaveCount(names.length)
  // Read position by position rather than as one blob of text: the row also
  // carries a number and a scope badge, and the order is the whole claim.
  for (const [index, name] of names.entries()) {
    await expect(page.getByTestId(`workflow-${index}-name`)).toHaveText(name)
  }
})

Then('the workflows cannot be changed', async ({ page }) => {
  await expect(page.getByTestId('plan-locked')).toBeVisible()
  await expect(page.getByTestId('available-workflows')).toHaveCount(0)
})

/* --------------------------------------------------------- menu sections */

Then('the menu has a {string} section', async ({ page }, name: string) => {
  await expect(page.getByTestId(`nav-section-${name}`)).toBeVisible()
})

Then('{string} is in the menu', async ({ page }, label: string) => {
  await expect(page.getByTestId(`nav-${label.toLowerCase()}`)).toBeVisible()
})

/* --------------------------------------------------------------- renaming */

When('I rename it to {string}', async ({ page }, name: string) => {
  await page.getByTestId('rename-task').click()
  await page.getByTestId('task-name-input').fill(name)
  await page.getByTestId('task-name-input').press('Enter')
})

Then('the task is called {string}', async ({ page }, name: string) => {
  await expect(page.getByRole('heading', { name })).toBeVisible()
})

Then('it cannot be renamed', async ({ page }) => {
  await expect(page.getByTestId('rename-task')).toHaveCount(0)
})

/* ------------------------------------------------------------ describing */

When('I describe it as {string}', async ({ page }, description: string) => {
  await page.getByTestId('describe-task').click()
  await page.getByTestId('task-description-input').fill(description)
  // Blur rather than Enter: the field is a textarea, where Enter is a newline.
  await page.getByTestId('task-description-input').blur()
})

Then("the task's description is {string}", async ({ page }, description: string) => {
  await expect(page.getByTestId('describe-task')).toHaveText(description)
})

Then('the description asks what the task is for', async ({ page }) => {
  await expect(page.getByTestId('describe-task')).toHaveText('What is this task for?')
})

Then('it cannot be described', async ({ page }) => {
  await expect(page.getByTestId('describe-task')).toHaveCount(0)
})

/* ----------------------------------------------------- token dictionary */

Then('the token dictionary is offered', async ({ page }) => {
  await expect(page.getByTestId('token-dictionary-toggle')).toBeVisible()
})

Then('the token list is not showing', async ({ page }) => {
  // A <details> that is closed keeps its contents in the DOM but unrendered.
  await expect(page.getByTestId('token-task-description')).toBeHidden()
})

When('I open the token dictionary', async ({ page }) => {
  await page.getByTestId('token-dictionary-toggle').click()
})

Then('{string} is listed', async ({ page }, token: string) => {
  // By value, not by testid, so the assertion is about what a person reads.
  await expect(
    page.getByTestId('token-dictionary').getByRole('button', { name: token, exact: true }),
  ).toBeVisible()
})

When('I declare the variable {string} as {string}', async ({ page }, key: string, value: string) => {
  await page.getByTestId('variables-add').click()
  const inputs = page.getByTestId('variables').locator('input')
  await inputs.nth(0).fill(key)
  await inputs.nth(1).fill(value)
  await inputs.nth(1).blur()
})

Then('the phase namespace says it declares none yet', async ({ page }) => {
  await expect(page.getByTestId('token-empty-phase')).toBeVisible()
})

/* ----------------------------------------------------------- environments */

Given(
  'the project {string} is registered, using environments',
  async ({ world }, name: string) => {
    await world.startDaemon()
    const id = await world.addProject(name, world.workDir)
    await fetch(world.api(`/api/projects/${id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usesEnvironments: true }),
    })
  },
)

Given(
  'the project defines the chain {string} then {string} then {string}',
  async ({ world }, first: string, second: string, third: string) => {
    // Each names only the one before it, which is the whole point: the chain is
    // written once and Factory walks it.
    world.workflow(world.projectScope, first, `name: ${first}\nphases: [greet]\n`)
    world.workflow(world.projectScope, second, `name: ${second}\nneeds: [${first}]\nphases: [greet]\n`)
    world.workflow(world.projectScope, third, `name: ${third}\nneeds: [${second}]\nphases: [greet]\n`)
    world.phase(world.projectScope, 'greet', 'name: greet\nsteps: [{run: echo hi}]\n')
    await world.startDaemon()
    await world.addProject('chained', world.workDir)
  },
)

Then('{string} is marked as having run', async ({ page }, name: string) => {
  const row = page.getByTestId(`task-workflow-${name}`)
  await expect(row.getByTitle('It has run, so it cannot be taken off the list')).toBeVisible()
})

Then('{string} is unticked', async ({ page }, name: string) => {
  await expect(
    page.getByTestId(`task-workflow-${name}`).locator('input[type=checkbox]'),
  ).not.toBeChecked()
})

Then('{string} has no remove button', async ({ page }, name: string) => {
  const row = page.getByTestId(`task-workflow-${name}`)
  await expect(row).toBeVisible()
  await expect(row.locator('[data-testid$="-remove"]')).toHaveCount(0)
})

Then('it offers to tick them all again', async ({ page }) => {
  await expect(page.getByTestId('tick-all')).toBeVisible()
})

Then('it says what was brought in', async ({ page }) => {
  await expect(page.getByTestId('pulled-in')).toBeVisible()
})

Given(
  'the project {string} is registered, without worktrees',
  async ({ world }, name: string) => {
    await world.startDaemon()
    const id = await world.addProject(name, world.workDir)
    // Worktrees are on by default, so this has to be switched off explicitly.
    await fetch(world.api(`/api/projects/${id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usesWorktrees: false }),
    })
  },
)

Given(
  'the project {string} is registered, using worktrees',
  async ({ world }, name: string) => {
    await world.startDaemon()
    await world.addProject(name, world.workDir)
  },
)

When('I pick the project {string} for the task', async ({ page }, name: string) => {
  await page.getByTestId('task-project').selectOption({ label: name })
})

Then('{string} is not on offer', async ({ page }, name: string) => {
  await expect(page.getByTestId('available-workflows')).toBeVisible()
  await expect(page.getByTestId(`pick-workflow-${name}`)).toHaveCount(0)
})

Then('{string} is on offer', async ({ page }, name: string) => {
  await expect(page.getByTestId(`pick-workflow-${name}`)).toBeVisible()
})

Given(
  'the task {string} in {string} is holding an environment',
  async ({ world }, name: string, project: string) => {
    // A real workflow earning the flag, because that is the only way a flag is
    // ever set — there is no API for claiming one, deliberately.
    world.withShell = true
    world.workflow(
      world.projectScope,
      'make-env',
      'name: make-env\nconditions: {provides: [hasEnvironment]}\nphases: [build-env]\n',
    )
    world.phase(world.projectScope, 'build-env', 'name: build-env\nsteps: [{run: echo built}]\n')
    await world.startDaemon()
    const id = await world.createTask(name, ['make-env'], world.projectIds.get(project))
    await world.runTask(id)
  },
)

When('I open the environments page', async ({ world, page }) => {
  await world.startDaemon()
  await page.goto('/environments')
})

When('I turn environments on for {string}', async ({ page }, name: string) => {
  await page.getByTestId(`open-project-${name}`).click()
  await page.getByTestId('project-environments-field').getByRole('checkbox').check()
  await page.getByTestId('save-project').click()
})

Then('the environments page is empty', async ({ page }) => {
  await expect(page.getByTestId('environments-empty')).toBeVisible()
})

Then('{string} says it gives each task an environment', async ({ page }, name: string) => {
  await expect(page.getByTestId(`environments-${name}`)).toBeVisible()
})

Then('the page lists what it copied in', async ({ page }) => {
  await expect(page.getByTestId('scaffolded')).toContainText('environment-create')
})

Then('{string} is listed as holding an environment', async ({ page }, name: string) => {
  await expect(page.getByTestId(`environment-${name}`)).toBeVisible()
})

/* ------------------------------------------------------------- step fields */

Given('the project defines the agent {string}', async ({ world }, name: string) => {
  world.agent(world.projectScope, name, `name: ${name}\nprovider: claude\nmodel: strong\n`)
})

Then(
  "the step's {string} field offers {string}",
  async ({ page }, field: string, option: string) => {
    // A combobox, not a select: the set is known but not closed, so the values
    // live in a datalist beside the input. A datalist option carries what it
    // offers in `value`, not as text — reading its text finds every option
    // empty and the assertion passes or fails for the wrong reason.
    const options = page.getByTestId('step-0').getByTestId(`field-${field}-options`)
    await expect
      .poll(async () => options.locator('option').evaluateAll((items) =>
        items.map((item) => (item as HTMLOptionElement).value),
      ))
      .toContain(option)
  },
)

When('I name the agent {string} on the step', async ({ page }, name: string) => {
  await page.getByTestId('step-0').getByTestId('field-agent').fill(name)
})

When("I set the step's {string} to {string}", async ({ page }, field: string, value: string) => {
  await page.getByTestId('step-0').getByTestId(`field-${field}`).fill(value)
})

When('I choose to override one', async ({ page }) => {
  await page.getByTestId('step-0').getByTestId('override-superseded').click()
})

Then('the step still asks for a {string}', async ({ page }, field: string) => {
  await expect(page.getByTestId('step-0').getByTestId(`field-${field}`)).toBeVisible()
})

Then('the step no longer asks for a {string}', async ({ page }, field: string) => {
  await expect(page.getByTestId('step-0').getByTestId(`field-${field}`)).toHaveCount(0)
})

Then('the step asks for a {string} again', async ({ page }, field: string) => {
  await expect(page.getByTestId('step-0').getByTestId(`field-${field}`)).toBeVisible()
})

Then('the step says {string} supplies them', async ({ page }, name: string) => {
  await expect(page.getByTestId('step-0').getByTestId('superseded-note')).toContainText(name)
})

/* -------------------------------------------------------------- workspace */

Given(
  'the task {string} exists on {string} in {string}',
  async ({ world }, name: string, workflow: string, project: string) => {
    await world.startDaemon()
    await world.createTask(name, [workflow], world.projectIds.get(project))
  },
)

Then('the workspace row names the project {string}', async ({ page }, name: string) => {
  await expect(page.getByTestId('workspace-project')).toHaveText(name)
})

Then("the workspace row shows the project's directory", async ({ world, page }) => {
  await expect(page.getByTestId('workspace-path')).toHaveText(world.workDir)
})

When('I copy the workspace path', async ({ page }) => {
  await page.getByTestId('workspace-path').click()
})

Then("the clipboard holds the project's directory", async ({ world, page }) => {
  // Read back rather than trusting the confirmation: the point of the button
  // is what ends up on the clipboard, and a label saying "copied" is only
  // evidence that the promise resolved.
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(world.workDir)
})

Then('the page says it copied it', async ({ page }) => {
  await expect(page.getByTestId('workspace-copied')).toBeVisible()
})

Then('the button offers to copy the command', async ({ page }) => {
  // The label stays the tool's own; what changes is that pressing it copies,
  // which the tooltip says and a mark shows.
  await expect(page.getByTestId('tool-open-terminal')).toContainText('Open terminal')
  await expect(page.getByTestId('tool-open-terminal')).toHaveAttribute('title', /^Copies: /)
})

When('I ask for a terminal', async ({ page }) => {
  await page.getByTestId('tool-open-terminal').click()
})

Then(
  'the clipboard holds a command that changes directory there',
  async ({ world, page }) => {
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`cd ${world.workDir}`)
  },
)

Then('the artifacts come after the workflows and before the runs', async ({ page }) => {
  // Document order, read off the page rather than assumed from the template:
  // a section moved back down would still render and still pass an
  // is-it-visible assertion.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id === 'task-plan' || id === 'artifacts' || id === 'runs'),
  )
  expect(order).toEqual(['task-plan', 'artifacts', 'runs'])
})

Given(
  'the project defines the workflow {string} whose agent carries a session',
  async ({ world }, name: string) => {
    world.workflow(world.projectScope, name, `name: ${name}\nphases: [look]\n`)
    // `session: task` is opted into, by the step or by the agent it names —
    // exactly as the real definitions do it. Without it there is no session for
    // anything to record, which is the scenario above.
    world.phase(
      world.projectScope,
      'look',
      [
        'name: look',
        'steps: [{uses: agent, provider: claude, session: task, prompt: Look at it}]',
        '',
      ].join('\n'),
    )
    world.withStubAgent = true
  },
)

Then('the session control is offered but not ready', async ({ page }) => {
  // Present and disabled. Asserting the row first means an empty page cannot
  // pass this by having no controls at all.
  await expect(page.getByTestId('task-workspace')).toBeVisible()
  await expect(page.getByTestId('tool-open-session')).toBeVisible()
  await expect(page.getByTestId('tool-open-session')).toBeDisabled()
})

Then('it says a session is recorded the first time an agent runs', async ({ page }) => {
  await expect(page.getByTestId('tool-open-session')).toHaveAttribute(
    'title',
    /first time an agent runs/,
  )
})

Then('the session control is ready', async ({ page }) => {
  await expect(page.getByTestId('tool-open-session')).toBeEnabled()
})

Then('the session command resumes by id', async ({ page }) => {
  // By id, not by `--continue`: that is the whole reason Factory mints one.
  await expect(page.getByTestId('tool-open-session')).toHaveAttribute(
    'title',
    /claude --resume [0-9a-f-]{36}$/,
  )
})

When('I ask for the session', async ({ page }) => {
  await page.getByTestId('tool-open-session').click()
})

Then('the clipboard holds a command that resumes by id', async ({ page }) => {
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^cd \S+ && claude --resume [0-9a-f-]{36}$/)
})

Then('the two core built-ins cannot be switched off', async ({ page }) => {
  // Listed with what they contribute, but no switch: without them nothing
  // parses or runs, and a control that bricks the installation is not a choice
  // worth offering.
  for (const id of ['@factory/core/builtin-steps', '@factory/config/builtin-doctor']) {
    await expect(page.getByTestId(`plugin-essential-${id}`)).toBeVisible()
    await expect(page.getByTestId(`plugin-toggle-${id}`)).toHaveCount(0)
  }
})

Given('the project declares a plugin contributing its own task tool', ({ world }) => {
  world.taskToolPlugin()
})

Then('the row offers {string}, {string} and {string}', async ({ page }, a: string, b: string, c: string) => {
  for (const label of [a, b, c]) {
    await expect(page.getByTestId('task-workspace')).toContainText(label)
  }
})

Then('the row offers a button labelled {string}', async ({ page }, label: string) => {
  await expect(page.getByTestId('tool-acme-docs')).toHaveText(label)
})

Then('it says which plugin provided it', async ({ page }) => {
  await page.goto('/plugins')
  await expect(page.getByTestId('plugin-./plugins/docs.mjs')).toContainText('task-tool:acme-docs')
})

When('I switch off the plugin providing {string}', async ({ page }, _label: string) => {
  await page.getByTestId('plugin-toggle-./plugins/docs.mjs').click()
})

When('I open the task again', async ({ page }) => {
  await page.getByTestId('nav-tasks').click()
  await page.getByTestId('open-Add due dates').click()
})

Then('the row does not offer {string}', async ({ page }, _label: string) => {
  await expect(page.getByTestId('task-workspace')).toBeVisible()
  await expect(page.getByTestId('tool-acme-docs')).toHaveCount(0)
})

When('I set the interface size to {int}', async ({ page }, scale: number) => {
  // Deliberately *not* through the settings page: these scenarios are about
  // what the shell does at a given scale, and they are already standing on the
  // task page when they ask. Navigating away and back would test the router.
  //
  // The comment here used to claim it went "through the store the settings page
  // drives", which it never did — it writes the setting and then applies the
  // same two properties the store applies. `the interface scale becomes {int}`
  // below is the one that drives the real control.
  await page.evaluate(async (value) => {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ui: { scale: value } }),
    })
    const root = document.documentElement
    root.style.zoom = value === 1 ? '' : String(value)
    root.style.setProperty('--app-zoom', String(value))
  }, scale)
})

Then('the page itself does not scroll', async ({ page }) => {
  const scrolls = await page.evaluate(() => {
    const root = document.documentElement
    root.scrollTop = 400
    const moved = root.scrollTop > 0
    root.scrollTop = 0
    return moved
  })
  expect(scrolls).toBe(false)
})

Then('the shell is exactly the height of the window', async ({ page }) => {
  const [shell, viewport] = await page.evaluate(() => [
    Math.round(document.querySelector('.app-viewport')!.getBoundingClientRect().height),
    window.innerHeight,
  ])
  expect(shell).toBe(viewport)
})

Then('the project rail is hidden', async ({ page }) => {
  await expect(page.getByLabel('Projects')).toBeHidden()
})

Then('the project rail is shown', async ({ page }) => {
  await expect(page.getByLabel('Projects')).toBeVisible()
})

Then('the menu is still there', async ({ page }) => {
  await expect(page.getByTestId('nav-tasks')).toBeVisible()
})

When("the root element's data-theme becomes {string}", async ({ page }, value: string) => {
  await page.evaluate((v) => {
    document.documentElement.dataset.theme = v
  }, value)
})

Then('the page background is the light base color', async ({ page }) => {
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(background).toBe('rgb(246, 246, 248)')
})

When('I open the settings page', async ({ page }) => {
  await page.getByTestId('nav-settings').click()
})

When('I choose the {string} theme', async ({ page }, label: string) => {
  await page.getByTestId(`theme-${label.toLowerCase()}`).click()
})

Then('the page uses the {string} theme', async ({ page }, value: string) => {
  // Polled rather than read once: `emulateMedia` acknowledges over CDP before
  // the renderer has necessarily dispatched the `change` event to script, so
  // the very next assertion can otherwise read the DOM a beat before the
  // store's listener has run.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(value)
})

When('the page is reloaded', async ({ page }) => {
  await page.reload()
})

Given('the browser prefers a light color scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
})

When('the browser starts preferring a dark color scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
})

Then('the veil tokens are black-based', async ({ page }) => {
  const value = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-veil-strong').trim(),
  )
  expect(value).toBe('rgba(0, 0, 0, 0.07)')
})

Then('the veil tokens are white-based', async ({ page }) => {
  const value = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-veil-strong').trim(),
  )
  expect(value).toBe('rgba(255, 255, 255, 0.06)')
})

Then("the draft badge's background is the light veil-strong color", async ({ page }) => {
  const color = await page
    .getByTestId('state-draft')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(color).toBe('rgba(0, 0, 0, 0.07)')
})


// ---------------------------------------------------------------- security

Given('nothing has been accepted on this installation', async ({ world }) => {
  // The scopes already exist — the feature's own Background made them — and the
  // daemon has not started yet, because that happens when a page is opened. So
  // removing the file is enough, and is what a first run actually looks like.
  world.freshInstallation = true
  rmSync(join(world.userScope, 'settings.json'), { force: true })
})

Given('the installation runs under Full Access', async ({ world }) => {
  world.unconfined = true
  world.write(
    join(world.userScope, 'settings.json'),
    JSON.stringify({ security: { acceptedVersion: 1, profile: 'full-access' } }),
  )
})

When('I queue it', async ({ page }) => {
  await page.getByTestId('action-queue').click()
})

When('I accept the disclaimer', async ({ page }) => {
  await page.getByTestId('accept-disclaimer').click()
})

When('the interface scale becomes {int}', async ({ page }, scale: number) => {
  // Through the control a person clicks, which is what the settings page had
  // no coverage of at all. Back afterwards, so the scenario can carry on
  // looking at the board.
  const wasAt = page.url()
  await page.getByTestId('nav-settings').click()
  await page.getByTestId(`scale-${scale}`).click()
  await page.goto(wasAt)
})

Then('no disclaimer is in the way', async ({ page }) => {
  await expect(page.getByTestId('disclaimer')).toHaveCount(0)
})

Then('the disclaimer appears', async ({ page }) => {
  await expect(page.getByTestId('disclaimer')).toBeVisible()
})

Then('the disclaimer is gone', async ({ page }) => {
  await expect(page.getByTestId('disclaimer')).toHaveCount(0)
})

Then('it says what an agent can do inside the workspace', async ({ page }) => {
  await expect(page.getByTestId('disclaimer-summary')).toContainText('inside the workspace')
})

Then('it names the profile that removes the boundaries', async ({ page }) => {
  await expect(page.getByTestId('disclaimer-points')).toContainText('Full Access')
})

Then('it says plainly that Factory is not a sandbox', async ({ page }) => {
  await expect(page.getByTestId('disclaimer-caveat')).toContainText('not a sandbox')
})

Then('the Full Access marker is visible', async ({ page }) => {
  await expect(page.getByTestId('full-access-badge')).toBeVisible()
})

Then('it is still visible on the settings page', async ({ page }) => {
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('full-access-badge')).toBeVisible()
})

Then('{string} leaves {string}', async ({ page }, name: string, state: string) => {
  // Queued, running or already done — anything but where it started. The point
  // is that the work was allowed to begin, not how far it got.
  await page.getByTestId('nav-tasks').click()
  await expect(
    page.getByTestId(`task-row-${name}`).getByTestId(`state-${state}`),
  ).toHaveCount(0, { timeout: 10_000 })
})

When('I follow {string}', async ({ page }, label: string) => {
  // By its test id rather than its text: this is the panel's own control, and
  // the label is prose somebody may reword.
  if (label === 'Review permissions') {
    await page.getByTestId('review-permissions').click()
    return
  }
  await page.getByRole('link', { name: label }).click()
})

When('I accept it there', async ({ page }) => {
  await page.getByTestId('accept-here').click()
})

Then('the settings page says nothing has been accepted', async ({ page }) => {
  await expect(page.getByTestId('disclaimer-state')).toContainText('Not yet accepted')
})

Then('the settings page says it is accepted', async ({ page }) => {
  await expect(page.getByTestId('disclaimer-state')).toContainText('Accepted, version')
})

Then('{string} is still {string}', async ({ page }, name: string, state: string) => {
  await page.getByTestId('nav-tasks').click()
  await expect(
    page.getByTestId(`task-row-${name}`).getByTestId(`state-${state}`),
  ).toBeVisible()
})

/* ------------------------------------------------- dependencies and batches */

const SLOW_WORKFLOW = 'name: slow\nphases: [wait]\n'
const SLOW_PHASE = 'name: wait\nsteps: [{run: sleep 30}]\n'

/**
 * A workflow that is still going when the scenario looks at it.
 *
 * "hello" finishes in a few hundred milliseconds, so a scenario about stopping
 * work would be racing it: by the time the button was pressed the task could
 * already be done, and the assertion would pass or fail according to the
 * machine.
 */
Given('the project defines a workflow {string} that does not finish', async ({ world }, name: string) => {
  world.workflow(world.projectScope, name, SLOW_WORKFLOW.replace('slow', name))
  world.phase(world.projectScope, 'wait', SLOW_PHASE)
  world.withShell = true
})

Given(
  'the task {string} exists in {string} with no workflow',
  async ({ world }, name: string, project: string) => {
    await world.startDaemon()
    await world.createTask(name, [], world.projectIds.get(project))
  },
)

Then('the header says {string}', async ({ page }, text: string) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(text)
})

Then('Queue all is offered', async ({ page }) => {
  await expect(page.getByTestId('queue-all')).toBeVisible()
})

Then('Queue all is not offered', async ({ page }) => {
  await expect(page.getByTestId('queue-all')).toHaveCount(0)
})

Then('Stop all is offered', async ({ page }) => {
  await expect(page.getByTestId('stop-all')).toBeVisible()
})

Then('Stop all is not offered', async ({ page }) => {
  await expect(page.getByTestId('stop-all')).toHaveCount(0)
})

When('I queue the whole project', async ({ page }) => {
  await page.getByTestId('queue-all').click()
})

When('I press Stop all', async ({ page }) => {
  await page.getByTestId('stop-all').click()
})

Then('it asks whether I really mean it', async ({ page }) => {
  await expect(page.getByTestId('stop-all-confirm')).toBeVisible()
})

When('I stop the whole project', async ({ page }) => {
  await page.getByTestId('stop-all').click()
  await page.getByTestId('stop-all-confirm').click()
})

When('{string} is running', async ({ page }, name: string) => {
  await expect(
    page.getByTestId(`task-row-${name}`).getByTestId('state-running'),
  ).toBeVisible({ timeout: 15_000 })
})

/**
 * Nothing came back up.
 *
 * Cancelling wakes the scheduler, so this is the clause that would catch a
 * stop that killed processes and left the queue alone. A wait rather than an
 * assertion on the spot: the failure it is looking for takes a tick to appear.
 */
Then('nothing starts again', async ({ page }) => {
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('summary-running')).toContainText('0')
})

Then('the page says it waits for nothing', async ({ page }) => {
  await expect(page.getByTestId('waits-for-nothing')).toBeVisible()
})

When('I make it wait for {string}', async ({ page }, name: string) => {
  await page.getByTestId('blocker-choice').selectOption({ label: name })
  await page.getByTestId('add-blocker').click()
})

Then('it waits for {string}', async ({ page }, name: string) => {
  await expect(page.getByTestId(`blocker-${name}`)).toBeVisible()
})

Then('{string} has not happened yet', async ({ page }, name: string) => {
  await expect(page.getByTestId(`blocker-${name}-status`)).toHaveText('not yet')
})

Then(
  'the row for {string} says it is waiting for {string}',
  async ({ page }, name: string, blocker: string) => {
    await expect(page.getByTestId(`waiting-${name}`)).toContainText(`waiting for ${blocker}`)
  },
)

Then('the refusal says it would make a ring', async ({ page }) => {
  await expect(page.getByTestId('dependency-error')).toContainText('ring')
})

When('I stop it waiting for {string}', async ({ page }, name: string) => {
  await page.getByTestId(`unblock-${name}`).click()
})

When('I mark it done', async ({ page }) => {
  await page.getByTestId('action-mark_done').click()
})

Then('the board says {string}', async ({ page }, sentence: string) => {
  // Generous, because Stop all answers only once the process trees are gone:
  // SIGTERM, then up to three seconds of grace per run, then SIGKILL.
  await expect(page.getByTestId('batch-report')).toContainText(sentence, { timeout: 15_000 })
})

Then(
  'it says {string} was left alone because nothing in its plan is ticked',
  async ({ page }, name: string) => {
    await expect(page.getByTestId('batch-skipped')).toContainText(
      `${name} (nothing in its plan is ticked)`,
    )
  },
)

When('I dismiss the report', async ({ page }) => {
  await page.getByTestId('dismiss-batch-report').click()
})

Then('the board says nothing about a batch', async ({ page }) => {
  await expect(page.getByTestId('batch-report')).toHaveCount(0)
})

Then('the row for {string} says nothing about waiting', async ({ page }, name: string) => {
  await expect(page.getByTestId(`waiting-${name}`)).toHaveCount(0)
})

Then('{string} can be chosen to wait for', async ({ page }, name: string) => {
  await expect(page.locator('[data-testid="blocker-choice"] option', { hasText: name })).toHaveCount(
    1,
  )
})

Then('{string} cannot be chosen to wait for', async ({ page }, name: string) => {
  // The picker has to be there for this to mean anything: with nothing to
  // offer it is not rendered at all, and an absent control would pass for the
  // wrong reason.
  await expect(page.getByTestId('blocker-choice')).toBeVisible()
  await expect(page.locator('[data-testid="blocker-choice"] option', { hasText: name })).toHaveCount(
    0,
  )
})
