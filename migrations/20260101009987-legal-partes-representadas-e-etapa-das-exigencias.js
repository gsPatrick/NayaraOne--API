'use strict';

/**
 * Matriz M5 (Caderno §7 "Requirements são gerados por tipo de contrato + regras + características das
 * partes/imóvel"; Guia §5 assertRequirementsSatisfied(contractId, targetStage)).
 *  - legal.contract_parties.represented_by_person_id: quem representa a parte (procurador) — característica
 *    da parte que faz o checklist exigir procuração.
 *  - legal.contract_requirements.required_stage: etapa a partir da qual a exigência bloqueia
 *    (LEGAL_REVIEW | LEGAL_APPROVAL | SIGNING | ACTIVATION | KEY_DELIVERY); legado = LEGAL_REVIEW, que é o
 *    comportamento anterior (toda pendência bloqueava o avanço).
 *  - legal.contract_requirements.rule_version_id: a versão da regra do Motor de Regras que gerou a exigência.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.contract_parties ADD COLUMN IF NOT EXISTS represented_by_person_id uuid NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT');
      await q(`ALTER TABLE legal.contract_requirements
        ADD COLUMN IF NOT EXISTS required_stage varchar(24) NOT NULL DEFAULT 'LEGAL_REVIEW',
        ADD COLUMN IF NOT EXISTS rule_version_id uuid NULL REFERENCES core.rule_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_requirements_stage_chk') THEN
          ALTER TABLE legal.contract_requirements ADD CONSTRAINT contract_requirements_stage_chk
            CHECK (required_stage IN ('LEGAL_REVIEW','LEGAL_APPROVAL','SIGNING','ACTIVATION','KEY_DELIVERY'));
        END IF;
      END $c$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.contract_requirements DROP CONSTRAINT IF EXISTS contract_requirements_stage_chk, DROP COLUMN IF EXISTS required_stage, DROP COLUMN IF EXISTS rule_version_id');
      await q('ALTER TABLE legal.contract_parties DROP COLUMN IF EXISTS represented_by_person_id');
    });
  },
};
