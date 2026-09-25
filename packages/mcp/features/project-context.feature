Feature: Knowing which project you are in
  The point of all this is that somebody types `claude` in a repository and the
  agent can act on it. So the one question that must always have an answer is
  "which Factory project is this directory in", and the agent is not the one who
  can answer it — it knows a path and nothing else.

  Factory answers it, and `factory mcp` asks. The match is the daemon's, for the
  reason every rule in this codebase lives in one place: the board and the CLI
  want the same answer, and a client that worked it out for itself would
  disagree with the daemon the first time the rule changed.

  What is refused matters as much as what is resolved. A directory that belongs
  to no project is a refusal that says what to do, and two projects with an equal
  claim are both named. Guessing would queue somebody's work against the wrong
  repository, and nothing downstream would notice.

  Client-declared workspace roots are deliberately not consulted. Reading them
  means the server making a request *of the client*, which is the only thing in
  this surface that would need it, and a stdio server is started in the
  directory the person is working in.

  Background:
    Given an MCP server started in "/repos/factory/packages/core"

  Scenario: The directory the server was started in is the project
    Given that directory is in the project "factory"
    When the agent asks which project it is in
    Then the project is "factory"
    And Factory was asked about "/repos/factory/packages/core"
    And the answer says the directory it used

  Scenario: A worktree says which task is being worked on
    Given that directory is a worktree of the task "Add due dates" in "factory"
    When the agent asks which project it is in
    Then the project is "factory"
    And the answer names the task "Add due dates"

  Scenario: A directory in no project says what to do about it
    Given that directory is in no project
    When the agent asks which project it is in
    Then it is refused as PROJECT_NOT_FOUND
    And the refusal says to pass a project or ask somebody to add the repository

  Scenario: Two projects with an equal claim are both named
    Given that directory is claimed by "factory" and "factory-again"
    When the agent asks which project it is in
    Then it is refused as PROJECT_AMBIGUOUS
    And the refusal names both

  Rule: a project the caller named is the one used

    A tool call may carry a project, and then the directory is irrelevant —
    an agent that has been told which repository to work in should not be
    overruled by where its session happens to have started.

    Scenario: A name is looked up among the projects
      Given the projects "factory" and "todolist"
      When the agent asks for the project "todolist"
      Then the project is "todolist"
      And Factory was not asked about any directory

    Scenario: An id is looked up among the projects
      Given the projects "factory" and "todolist"
      When the agent asks for the project by todolist's id
      Then the project is "todolist"

    Scenario: A name matches whatever case it was typed in
      Given the projects "factory" and "todolist"
      When the agent asks for the project "ToDoList"
      Then the project is "todolist"

    Scenario: Anything starting with a separator is treated as a path
      # The one unambiguous signal. A project may be named anything, so asking
      # "is this a path?" any other way means guessing about somebody's naming.
      Given the projects "factory" and "todolist"
      When the agent asks for the project "/repos/todolist/src"
      Then Factory was asked about "/repos/todolist/src"

    Scenario: A name nobody has says what there is
      Given the projects "factory" and "todolist"
      When the agent asks for the project "factoree"
      Then it is refused as PROJECT_NOT_FOUND
      And the refusal lists "factory" and "todolist"
