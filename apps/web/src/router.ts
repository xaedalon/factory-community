import { createRouter, createWebHistory } from 'vue-router'
import TasksPage from './pages/TasksPage.vue'
import NewTaskPage from './pages/NewTaskPage.vue'
import TaskDetailPage from './pages/TaskDetailPage.vue'
import ArtifactPage from './pages/ArtifactPage.vue'
import ProjectsPage from './pages/ProjectsPage.vue'
import ProjectEditPage from './pages/ProjectEditPage.vue'
import SetupPage from './pages/SetupPage.vue'
import WorkflowListPage from './pages/WorkflowListPage.vue'
import PhaseListPage from './pages/PhaseListPage.vue'
import EnvironmentsPage from './pages/EnvironmentsPage.vue'
import AgentListPage from './pages/AgentListPage.vue'
import AgentEditPage from './pages/AgentEditPage.vue'
import PluginsPage from './pages/PluginsPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import ScopesPage from './pages/ScopesPage.vue'
import WorkflowEditPage from './pages/WorkflowEditPage.vue'
import PhaseEditPage from './pages/PhaseEditPage.vue'
import BundleImportPage from './pages/BundleImportPage.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    // Tasks first: the board is what someone opens Factory to look at, and the
    // definitions are what they edit occasionally.
    { path: '/', redirect: '/tasks' },
    { path: '/tasks', name: 'tasks', component: TasksPage },
    // Before '/tasks/:id', or "new" is read as a task id.
    { path: '/tasks/new', name: 'task-new', component: NewTaskPage },
    { path: '/tasks/:id', name: 'task', component: TaskDetailPage },
  {
    path: '/tasks/:id/artifacts/:name',
    name: 'task-artifact',
    component: ArtifactPage,
  },
    { path: '/projects', name: 'projects', component: ProjectsPage },
    // Before '/projects/:id', or "new" is read as a project id — the same
    // ordering '/tasks/new' needs, and for the same reason.
    { path: '/projects/new', name: 'project-new', component: ProjectEditPage },
    { path: '/projects/:id', name: 'project-edit', component: ProjectEditPage },
    { path: '/setup', name: 'setup', component: SetupPage },
    { path: '/workflows', name: 'workflows', component: WorkflowListPage },
    { path: '/workflows/new', name: 'workflow-new', component: WorkflowEditPage },
    { path: '/workflows/:name', name: 'workflow-edit', component: WorkflowEditPage },
    { path: '/environments', name: 'environments', component: EnvironmentsPage },
    { path: '/agents', name: 'agents', component: AgentListPage },
    { path: '/agents/new', name: 'agent-new', component: AgentEditPage },
    { path: '/agents/:name', name: 'agent-edit', component: AgentEditPage },
    { path: '/phases', name: 'phases', component: PhaseListPage },
    { path: '/phases/new', name: 'phase-new', component: PhaseEditPage },
    { path: '/phases/:name', name: 'phase-edit', component: PhaseEditPage },
    { path: '/bundles/import', name: 'bundle-import', component: BundleImportPage },
    { path: '/plugins', name: 'plugins', component: PluginsPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/scopes', name: 'scopes', component: ScopesPage },
  ],
})
