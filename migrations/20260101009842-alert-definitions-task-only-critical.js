'use strict';

/**
 * Marco 9, demanda M9-D692 (Caderno §16): "Alerta crítico pode criar tarefa/ocorrência". A tarefa é só de alerta CRITICAL: a definição com
 * create_task em INFO/WARNING é recusada pelo serviço (422 ANALYTICS_ALERT_TASK_ONLY_CRITICAL) e, como trava final, pelo CHECK
 * alert_definitions_task_only_critical. NOT VALID: vale para toda linha nova ou alterada sem reescrever o histórico (os alertas semente já só
 * ligam a tarefa em CRITICAL, M9-D691). Sem tabela nova (nada de RLS/GRANT a acrescentar). SQL puro e idempotente. Faixa reservada: 9842 a 9849.
 */
const T = '"analytics"."alert_definitions"';

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regclass('analytics.alert_definitions') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009602 (alertas do BI).');
    await q(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS alert_definitions_task_only_critical`);
    await q(`ALTER TABLE ${T} ADD CONSTRAINT alert_definitions_task_only_critical CHECK (create_task = false OR severity = 'CRITICAL') NOT VALID`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS alert_definitions_task_only_critical`);
  },
};
