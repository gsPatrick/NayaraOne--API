'use strict';

/**
 * BUG CRÍTICO ENCONTRADO (auditoria E2E ao vivo, Marco 6, Ciclo 7 de RLS, 2026-10-06): mesmo
 * problema já corrigido em `construction` (migration 20260101000282) e `finance` (migration
 * 20260101000283) existia também nos schemas `core` (26 tabelas, incluindo `users`,
 * `role_permissions`, `permissions`, `sessions`, `mfa_credentials` — usadas diretamente pelo
 * fluxo de login/MFA e por `responsible_user_id` referenciado por Marco 6) e `integration`
 * (3 tabelas: `domain_events`, `integration_inbox`, `outbox_events` — usadas pelo motor de
 * eventos que Marco 6 dispara em toda transição de etapa/medição de obra). Mesma causa raiz
 * provável (GRANT ALL aplicado manualmente em algum momento) e mesma violação de privilégio
 * mínimo (IAM-003). Revoga os 3 privilégios excedentes, mantendo só SELECT/INSERT/UPDATE/DELETE.
 */
const AFFECTED = {
  core: [
    'companies', 'groups', 'mfa_credentials', 'mfa_step_ups', 'notifications', 'permissions',
    'role_permissions', 'roles', 'rule_approval_requests', 'rule_approval_steps',
    'rule_dependencies', 'rule_evaluation_log', 'rule_exceptions', 'rule_publications',
    'rule_scopes', 'rule_simulations', 'rule_test_cases', 'rule_versions', 'rules', 'sessions',
    'substitutions', 'system_settings', 'tasks', 'tenant_settings', 'units', 'user_memberships',
    'users',
  ],
  integration: ['domain_events', 'integration_inbox', 'outbox_events'],
};

// GAP REAL CORRIGIDO (CI quebrado, 08/10/2026): "nayara_runtime" só existe em produção —
// ausente no CI, quebrando `npm run migrate` com "role ... does not exist".
async function runtimeRoleExists(queryInterface) {
  const [[{ exists }]] = await queryInterface.sequelize.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
  );
  return exists;
}

module.exports = {
  async up(queryInterface) {
    if (!(await runtimeRoleExists(queryInterface))) return;
    for (const [schema, tables] of Object.entries(AFFECTED)) {
      for (const table of tables) {
        await queryInterface.sequelize.query(
          `REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE "${schema}"."${table}" FROM nayara_runtime;`
        );
      }
    }
  },

  async down(queryInterface) {
    if (!(await runtimeRoleExists(queryInterface))) return;
    for (const [schema, tables] of Object.entries(AFFECTED)) {
      for (const table of tables) {
        await queryInterface.sequelize.query(
          `GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE "${schema}"."${table}" TO nayara_runtime;`
        );
      }
    }
  },
};
