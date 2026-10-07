'use strict';

/**
 * BUG CRÍTICO ENCONTRADO (auditoria E2E ao vivo, Marco 6, Ciclo 5 de RLS, 2026-10-06):
 * `nayara_runtime` (role de runtime da aplicação, sem BYPASSRLS/superuser) tinha privilégios
 * EXCEDENTES (TRUNCATE, TRIGGER, REFERENCES) em 12 das 20 tabelas do schema `construction`
 * (budget_lines, daily_materials, daily_reports, daily_workers, maintenance_cases,
 * material_requests, measurement_items, project_stages, projects, quality_checklist_items,
 * stage_dependencies, stage_measurements) — provavelmente herdados de um `GRANT ALL` aplicado
 * manualmente nessas tabelas específicas em algum momento, divergindo do padrão correto
 * (SELECT/INSERT/UPDATE/DELETE apenas) já usado nas outras 8 tabelas do mesmo schema.
 * Violação do princípio de privilégio mínimo (IAM-003): a role de aplicação nunca deveria poder
 * truncar uma tabela inteira ou criar triggers em runtime. Revoga explicitamente os 3
 * privilégios excedentes, mantendo só o necessário.
 */
const AFFECTED_TABLES = [
  'budget_lines', 'daily_materials', 'daily_reports', 'daily_workers', 'maintenance_cases',
  'material_requests', 'measurement_items', 'project_stages', 'projects',
  'quality_checklist_items', 'stage_dependencies', 'stage_measurements',
];

module.exports = {
  async up(queryInterface) {
    for (const table of AFFECTED_TABLES) {
      await queryInterface.sequelize.query(
        `REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE "construction"."${table}" FROM nayara_runtime;`
      );
    }
  },

  async down(queryInterface) {
    for (const table of AFFECTED_TABLES) {
      await queryInterface.sequelize.query(
        `GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE "construction"."${table}" TO nayara_runtime;`
      );
    }
  },
};
