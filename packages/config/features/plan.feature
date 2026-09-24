Feature: Definitions become a runnable plan
  Planning resolves a workflow, its phases and its steps into concrete
  processes — and executes nothing. That separation is what lets `doctor` and
  `--dry-run` show exactly what a run would do without doing any of it.

  It is also what keeps the schema honest. A field nothing can consume does not
  work however cleanly it validates, which is exactly how the prototype ended up
  with a documented `working_dir` that no code ever read. Every field has to
  survive the trip to here.

  Background:
    Given the built-in step kinds and one agent provider are registered

  Scenario: The built-in workflow plans
    When the workflow "hello-world" is planned
    Then planning succeeds
    And the plan has 1 phase
    And phase "greet" requires approval
    And phase "greet" step 0 runs "bash"

  Scenario: A shell step becomes a bash command
    Given the project scope defines a phase "build" running "npm test"
    And the project scope defines a workflow "ci" with the phase "build"
    When the workflow "ci" is planned
    Then planning succeeds
    And phase "build" step 0 runs "bash"
    And phase "build" step 0 passes "npm test"

  Scenario: An agent step becomes the provider's command
    Given the project scope defines a phase "analyse" with an agent step
    And the project scope defines a workflow "review" with the phase "analyse"
    When the workflow "review" is planned
    Then planning succeeds
    And phase "analyse" step 0 runs "claude"
    And phase "analyse" step 0 passes the prompt

  Scenario: Variables are substituted before the step is planned
    Given the project scope defines a phase "greet-task" echoing "{{ task.ticketId }}"
    And the project scope defines a workflow "greeting" with the phase "greet-task"
    When the workflow "greeting" is planned for the task "WW2-1234"
    Then planning succeeds
    And phase "greet-task" step 0 passes "WW2-1234"

  Scenario: A token that does not resolve is a warning naming it
    Given the project scope defines a phase "typo" echoing "{{ task.nmae }}"
    And the project scope defines a workflow "oops" with the phase "typo"
    When the workflow "oops" is planned for the task "WW2-1234"
    Then planning succeeds
    And there is a warning about an unresolved token
    And the warning names "task.nmae"

  Scenario: A namespace Factory does not own is left alone
    Given the project scope defines a phase "template" echoing "{{ mustache.name }}"
    And the project scope defines a workflow "templating" with the phase "template"
    When the workflow "templating" is planned
    Then planning succeeds
    And there are no warnings about unresolved tokens
    And phase "template" step 0 passes "{{ mustache.name }}"

  Scenario: working_dir is honoured rather than merely documented
    Given the project scope defines a phase "web-build" with working directory "web"
    And the project scope defines a workflow "site" with the phase "web-build"
    When the workflow "site" is planned
    Then planning succeeds
    And phase "web-build" runs in a directory ending "web"

  Scenario: A workflow naming a phase that does not exist fails clearly
    Given the project scope defines a workflow "broken" with the phase "absent"
    When the workflow "broken" is planned
    Then planning fails
    And a problem names the missing phase "absent"

  Scenario: A workflow that does not exist fails clearly
    When the workflow "nowhere" is planned
    Then planning fails
    And a problem says there is no such workflow

  Scenario: A step kind that cannot run is reported, not skipped
    Given a plugin registers a "http" step kind with no planner
    And the project scope defines a phase "fetch" using the "http" step kind
    And the project scope defines a workflow "fetching" with the phase "fetch"
    When the workflow "fetching" is planned
    Then planning fails
    And a problem says the step kind cannot be run

  Scenario: An agent step naming an unknown provider fails clearly
    Given the project scope defines a phase "wrong-agent" using the provider "gemini"
    And the project scope defines a workflow "guess" with the phase "wrong-agent"
    When the workflow "guess" is planned
    Then planning fails
    And a problem lists the installed providers

  Scenario: With one provider installed a step need not name it
    Given the project scope defines a phase "analyse" with an agent step
    And the project scope defines a workflow "review" with the phase "analyse"
    When the workflow "review" is planned
    Then planning succeeds
    And phase "analyse" step 0 runs "claude"

  Scenario: With several providers installed an unnamed step is ambiguous
    Given a second agent provider is registered
    And the project scope defines a phase "analyse" with an agent step
    And the project scope defines a workflow "review" with the phase "analyse"
    When the workflow "review" is planned
    Then planning fails
    And a problem says the step does not say which agent to use

  Scenario: A setting the chosen agent ignores is warned about at planning time
    Given the project scope defines a phase "effortful" asking for effort on copilot
    And the project scope defines a workflow "effortfully" with the phase "effortful"
    And the copilot provider is registered
    When the workflow "effortfully" is planned
    Then planning succeeds
    And there is a warning about effort

  Rule: a step may name an agent, and the agent supplies the settings

    Scenario: The named agent's provider and model are used
      Given the project scope defines an agent "developer" using claude and the strong model
      And the project scope defines a phase "build" whose step names the agent "developer"
      And the project scope defines a workflow "building" with the phase "build"
      When the workflow "building" is planned
      Then planning succeeds
      And the planned command carries the strong model

    Scenario: A setting on the step beats the agent's
      Given the project scope defines an agent "developer" using claude and the strong model
      And the project scope defines a phase "build" whose step names "developer" but asks for the fast model
      And the project scope defines a workflow "building" with the phase "build"
      When the workflow "building" is planned
      Then planning succeeds
      And the planned command carries the fast model

    Scenario: Naming an agent that does not exist fails clearly
      Given the project scope defines a phase "build" whose step names the agent "nobody"
      And the project scope defines a workflow "building" with the phase "build"
      When the workflow "building" is planned
      Then planning fails
      And a problem mentions "nobody"

  Rule: an artifact is promised to the agent and looked for in the same place

    Two derivations of one path is how an agent gets told to write one file
    while the collector waits for another — which is exactly what happened: a
    binary `join` where the helper was variadic dropped the filename from the
    collector's copy and nothing noticed, because the prompt was built by the
    other one.

    Scenario: The prompt names the file the plan will collect
      Given the project scope defines a phase "review" whose agent step writes the artifact "analysis"
      And the project scope defines a workflow "reviewing" with the phase "review"
      When the workflow "reviewing" is planned for a task
      Then planning succeeds
      And the step carries the artifact "analysis"
      And the prompt tells the agent to write to exactly that path

    Scenario: The path is Markdown, under the task's own artifacts directory
      Given the project scope defines a phase "review" whose agent step writes the artifact "analysis"
      And the project scope defines a workflow "reviewing" with the phase "review"
      When the workflow "reviewing" is planned for a task
      Then the artifact is at "artifacts/analysis/analysis.md"

    Scenario: A step with no artifact has nothing added to its prompt
      Given the project scope defines a phase "plain" whose agent step writes no artifact
      And the project scope defines a workflow "plainly" with the phase "plain"
      When the workflow "plainly" is planned for a task
      Then the prompt is exactly what was written

    Scenario: What the timeline shows is the prompt as written
      Given the project scope defines a phase "review" whose agent step writes the artifact "analysis"
      And the project scope defines a workflow "reviewing" with the phase "review"
      When the workflow "reviewing" is planned for a task
      Then the step is described by the author's first line

  Rule: the token dictionary documents tokens that actually resolve

    The vocabulary used to live in four files with no way to disagree loudly —
    the interface that declared it, the daemon that filled it, the resolver that
    assembled the scope, and prose. The types now stop the keys drifting apart;
    these scenarios stop the *values* drifting, which no type can see.

    Scenario: Every task token the dictionary lists resolves to a value
      Given a phase whose step uses every task token the dictionary documents
      And the project scope defines a workflow "vocabulary" with that phase
      When the workflow "vocabulary" is planned for a task with every field set
      Then planning succeeds
      And no token was left unresolved
      And every documented task token was replaced by its value
      And the artifacts token is the root the plan derived, not one it was handed

    Scenario: Every project token the dictionary lists resolves to a value
      Given a phase whose step uses every project token the dictionary documents
      And the project scope defines a workflow "vocabulary" with that phase
      When the workflow "vocabulary" is planned with every project value set
      Then planning succeeds
      And no token was left unresolved

    Scenario: A task token the dictionary does not list is a warning
      Given a phase whose step uses "{{ task.worktreePath }}"
      And the project scope defines a workflow "vocabulary" with that phase
      When the workflow "vocabulary" is planned for a task with every field set
      Then a problem names the unresolved token "{{ task.worktreePath }}"
      And the problem lists what the namespace does have

    Scenario: The dictionary says which namespaces it cannot fill itself
      When the token dictionary is read
      Then "task" and "project" are filled by Factory
      And "workflow", "phase" and "variables" come from the definition

  Rule: the task namespace is complete however the plan was reached

    The daemon builds it with `taskTokenValues`, which is total by construction.
    A foreground `factory run` built it by hand from the flags it was given, so
    `{{ task.artifacts }}` — the token a phase uses to read what an earlier one
    wrote — did not resolve at all outside the daemon, and the warning listed
    the two keys that happened to be set as though those were all there were.

    One derivation now: the resolver fills every documented key, then the
    caller's values, then the artifacts root it already computed for the wrapper.

    Scenario: A plan with no task at all still resolves the artifacts root
      Given the project scope defines a phase "reader" that reads an earlier artifact
      And the project scope defines a workflow "reading" with the phase "reader"
      When the workflow "reading" is planned with no task
      Then planning succeeds
      And no token was left unresolved
      And the command names an absolute artifacts path

    Scenario: A documented token nobody supplied is empty, not missing
      Given the project scope defines a phase "ticketed" that echoes the ticket
      And the project scope defines a workflow "ticketing" with the phase "ticketed"
      When the workflow "ticketing" is planned with no task
      Then planning succeeds
      And no token was left unresolved

    Scenario: The artifacts token and the wrapper name the same root
      Given the project scope defines a phase "both" that reads an artifact and writes one
      And the project scope defines a workflow "bothly" with the phase "both"
      When the workflow "bothly" is planned with no task
      Then the path it was told to read from is under the same root it writes to

  Rule: one session per plan, started by the first agent step that needs it

    Factory chooses the session id so that it can be resumed exactly — by a
    later phase, by a re-run, and by a person opening a terminal. That means
    knowing which command to render, because starting a session and continuing
    one are different: `--session-id` refuses an id that exists and `--resume`
    refuses one that does not.

    The decision is made here rather than as the run goes, because a plan is
    resolved once, up front. So the ordering is a promise this makes: the first
    agent step of the plan starts the session and every later one continues it.

    Scenario: The first agent step starts the session
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned with the new session "s-1"
      Then planning succeeds
      And the first agent step starts the session "s-1"

    Scenario: A later agent step continues it
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned with the new session "s-1"
      Then the second agent step resumes the session "s-1"

    Scenario: Two agent steps in one phase follow the same rule
      Given the project scope defines a phase "twice" with two agent steps
      And the project scope defines a workflow "double" with the phase "twice"
      When the workflow "double" is planned with the new session "s-1"
      Then the first agent step starts the session "s-1"
      And the second step of "twice" resumes the session "s-1"

    Scenario: A shell step in between does not consume the session
      Given the project scope defines a workflow "mixed" with a shell phase then an agent phase
      When the workflow "mixed" is planned with the new session "s-1"
      # A shell step has no session to start, so the agent step after it is
      # still the first one that does.
      Then the first agent step starts the session "s-1"

    Scenario: A session that already exists is continued from the very first step
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned with the existing session "s-1"
      Then the first agent step resumes the session "s-1"
      And no step starts a session

    Scenario: The starting step carries a retry that resumes instead
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned with the new session "s-1"
      # Running the starting command twice is refused by the CLI, so a retry of
      # that step has to continue the session it just made.
      Then the first agent step's retry resumes the session "s-1"

    Scenario: A later step needs no retry command of its own
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned with the new session "s-1"
      Then the second agent step has no separate retry command

    Scenario: Planning with no session renders no session flags
      Given the project scope defines a workflow "review" with two agent phases
      When the workflow "review" is planned
      Then planning succeeds
      And no step mentions a session

  Rule: a phase runs inside the workspace, or the plan is refused

    `working_dir` is honoured, which the rule above establishes. Nothing checked
    where it pointed. `joinPath` lets an absolute part restart the path, so
    `working_dir: /tmp` discarded the workspace and ran in `/tmp`, and a `..`
    climb was never normalised — and the schema is `z.string().min(1)`, so
    neither was caught anywhere else either.

    An error rather than a clamp. Quietly rewriting somebody's `working_dir` to
    a directory they did not name would run their steps in the wrong place, and
    a workflow that meant it should hear so. Under Full Access it is a stated
    choice, so it is a warning and it runs.

    Scenario: A relative working directory inside the workspace is fine
      Given the project scope defines a phase "web-build" with working directory "web"
      And the project scope defines a workflow "site" with the phase "web-build"
      When the workflow "site" is planned
      Then planning succeeds

    Scenario: An absolute working directory is refused
      Given the project scope defines a phase "escape" with working directory "/tmp"
      And the project scope defines a workflow "site" with the phase "escape"
      When the workflow "site" is planned
      Then planning fails
      And a problem names the phase's working directory
      And the problem says which profile allows it

    Scenario: A working directory that climbs out is refused
      Given the project scope defines a phase "escape" with working directory "../../elsewhere"
      And the project scope defines a workflow "site" with the phase "escape"
      When the workflow "site" is planned
      Then planning fails
      And a problem names the phase's working directory

    Scenario: A working directory that climbs out and back is fine
      Given the project scope defines a phase "web-build" with working directory "../work/web"
      And the project scope defines a workflow "site" with the phase "web-build"
      When the workflow "site" is planned
      # The check is on the resolved path, so a route that leaves and returns is
      # not an escape — only a destination outside is.
      Then planning succeeds

    Scenario: Full Access allows it and says so
      Given the project scope defines a phase "escape" with working directory "/tmp"
      And the project scope defines a workflow "site" with the phase "escape"
      When the workflow "site" is planned under Full Access
      Then planning succeeds
      And a warning names the phase's working directory
      And phase "escape" runs in "/tmp"

  Rule: a workflow that would run nothing is refused rather than run

    This looked exactly like success. `runPlan` walks zero phases, returns
    completed, and the run lands three milliseconds later with no steps and no
    artifact — so the board draws a tick beside work that never happened. A
    supervised run of ten tasks had a workflow shaped like this on every one of
    them, and nobody could tell from the outside.

    Counted in steps rather than phases, because "lists no phases" and "lists
    only empty phases" are the same claim: there is nothing here to run.

    Refused at plan time rather than reported at run time, so it takes the path
    a missing phase already takes — no plan, a run recorded as refused, and the
    task blocked with a reason.

    Scenario: A workflow with no phases at all
      Given the project scope defines a workflow "design" with no phases
      When the workflow "design" is planned
      Then planning fails
      And a problem says the workflow has nothing to run

    Scenario: A workflow whose only phase has no steps
      Given the project scope defines a phase "think" with no steps
      And the project scope defines a workflow "design" with the phase "think"
      When the workflow "design" is planned
      Then planning fails
      And a problem says the workflow has nothing to run

    Scenario: One empty phase beside a real one is not refused
      # The workflow still runs something, and an empty phase is the author's
      # business — the parser already warns about it.
      Given the project scope defines a phase "think" with no steps
      And the project scope defines a phase "work" that prints "building"
      And the project scope defines a workflow "design" with the phases "think, work"
      When the workflow "design" is planned
      Then planning succeeds

  Rule: a step cannot argue its way past the profile it runs under

    `args:` is appended to the rendered command *after* the permission
    arguments, and nothing checked it. So a phase — or a named agent, which is
    a file in the project the agent itself can edit — could say
    `args: ['--permission-mode', 'bypassPermissions']` and run under Full
    Access while the project's profile still said Default. No setting changed,
    nothing said, and the only trace a line in a YAML file.

    Refused at plan time, so the run is recorded `refused` and the task blocked
    with a reason, rather than an argv nobody reads granting authority nobody
    chose.

    Scenario: A step whose args would grant Full Access is refused
      Given the project scope defines a phase "sneaky" passing "--permission-mode bypassPermissions"
      And the project scope defines a workflow "review" with the phase "sneaky"
      When the workflow "review" is planned
      Then planning fails
      And a problem says the step asks for more authority than the profile allows

    Scenario: A named agent cannot do it either
      # The agent file is the more dangerous of the two: it is further from the
      # phase somebody reads, and it applies to every step that names it.
      Given the project scope defines an agent "sneaky" passing "--permission-mode bypassPermissions"
      And the project scope defines a phase "build" whose step names the agent "sneaky"
      And the project scope defines a workflow "building" with the phase "build"
      When the workflow "building" is planned
      Then planning fails
      And a problem says the step asks for more authority than the profile allows

    Scenario: Under Full Access the same step plans
      # There is no boundary left to widen, and the profile was chosen
      # deliberately and is marked on screen the whole time it is on.
      Given the project scope defines a phase "sneaky" passing "--permission-mode bypassPermissions"
      And the project scope defines a workflow "review" with the phase "sneaky"
      When the workflow "review" is planned under Full Access
      Then planning succeeds

    Scenario: An ordinary argument still works
      Given the project scope defines a phase "verbose" passing "--verbose"
      And the project scope defines a workflow "review" with the phase "verbose"
      When the workflow "review" is planned
      Then planning succeeds
      And phase "verbose" step 0 passes "--verbose"

  Rule: the gate runs the project's own command, or refuses to run at all

    The `validate` workflow of a supervised run passed ten times by asking an
    agent whether the work was good. It said yes, with nothing installed and the
    test suite never run. An agent's report is a claim; only a command is a
    result.

    The gate itself already existed — a shell step whose non-zero exit fails the
    phase and blocks the task. What was missing was anything that knew what to
    run. `{{ project.check }}` is that, and the built-in `project-check` phase
    is nothing but that command.

    So the empty case is the dangerous one, and it is the one this rule is
    mostly about: `bash -c ''` exits 0, so a project with no check command would
    have made the gate a tick beside nothing.

    Scenario: The built-in gate runs the project's check command
      Given the project's check command is "pnpm test"
      And the project scope defines a workflow "validate" with the phase "project-check"
      When the workflow "validate" is planned
      Then planning succeeds
      And phase "project-check" step 0 runs the project's check command

    Scenario: A project with no check command cannot plan the gate
      Given the project has no check command
      And the project scope defines a workflow "validate" with the phase "project-check"
      When the workflow "validate" is planned
      Then planning fails
      And a problem says the step has no command to run

    Scenario: Any step whose command resolves to nothing is refused
      # Not a special case for the gate. A variable that resolves to nothing is
      # an empty command wherever it appears, and an empty command is a tick.
      Given the project scope defines a phase "empty" running "{{ project.check }}"
      And the project has no check command
      And the project scope defines a workflow "validate" with the phase "empty"
      When the workflow "validate" is planned
      Then planning fails
      And a problem says the step has no command to run

