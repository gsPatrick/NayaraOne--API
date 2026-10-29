'use strict';

/**
 * Marco 9, demanda M9-D660 (KPIs do Jurídico): campos de qualidade que os KPIs precisam dos read models do Jurídico da M9-D619. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9726. Idempotente. Faixa reservada: 9808 a 9815.
 *   rm_legal_deadlines          without_date                    prazos abertos sem data de vencimento (regra de qualidade: INCOMPLETE)
 *   rm_legal_missing_docs       requirements_without_deadline   exigências pendentes cujo contrato não tem início de vigência (o prazo da exigência)
 * O segundo é NULO até o read model ser recalculado (evento ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  ['rm_legal_deadlines', 'without_date integer NOT NULL DEFAULT 0 CHECK (without_date >= 0)'],
  ['rm_legal_missing_docs', 'requirements_without_deadline integer CHECK (requirements_without_deadline IS NULL OR requirements_without_deadline >= 0)'],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
