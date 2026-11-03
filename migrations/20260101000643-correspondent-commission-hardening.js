'use strict';

/**
 * Migration: Marco 8 — fechamentos da auditoria exaustiva de 26/10/2026 (comissão e Financeiro).
 *
 * 1) commission_entitlements: CHECKs de domínio (status, valores, percentuais) e índice por lançamento
 *    financeiro. Os CHECKs entram NOT VALID: valem para toda linha nova ou alterada sem reprovar dado antigo.
 * 2) O direito à comissão é imutável: o papel de runtime perde DELETE (o estorno é um ajuste, nunca apagar).
 * 3) A identificação de confirmação do banco volta a poder ser usada depois de a comissão ter sido estornada
 *    (o índice único deixa de contar as comissões ajustadas).
 * 4) commission_adjustments aceita estorno parcial e diferença de recebimento.
 * 5) Centro de resultado padrão da comissão: um só por empresa (duplicados antigos são desativados
 *    por exclusão lógica, mantendo o mais antigo).
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      ADD CONSTRAINT commission_entitlements_status_check CHECK (status IN ('EXPECTED','CONFIRMED','RECEIVABLE','RECEIVED','ADJUSTED')) NOT VALID,
      ADD CONSTRAINT commission_entitlements_amount_check CHECK (amount > 0 AND base_amount > 0) NOT VALID,
      ADD CONSTRAINT commission_entitlements_percentage_check CHECK (percentage > 0 AND percentage <= 100) NOT VALID,
      ADD CONSTRAINT commission_entitlements_share_check CHECK (broker_share_pct BETWEEN 0 AND 100 AND manager_share_pct BETWEEN 0 AND 100) NOT VALID;`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS commission_entitlements_financial_entry_idx
      ON "correspondent"."commission_entitlements" (financial_entry_id) WHERE financial_entry_id IS NOT NULL;`);

    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."commission_entitlements_external_confirmation_unique";');
    await sequelize.query(`CREATE UNIQUE INDEX commission_entitlements_external_confirmation_unique
      ON "correspondent"."commission_entitlements" (company_id, lower(external_confirmation_id))
      WHERE external_confirmation_id IS NOT NULL AND status <> 'ADJUSTED';`);

    await sequelize.query('ALTER TABLE "correspondent"."commission_adjustments" DROP CONSTRAINT IF EXISTS commission_adjustments_type_check;');
    await sequelize.query(`ALTER TABLE "correspondent"."commission_adjustments"
      ADD CONSTRAINT commission_adjustments_type_check CHECK (adjustment_type IN ('CHARGEBACK','PARTIAL_CHARGEBACK','RECEIPT_DIFFERENCE'));`);
    await sequelize.query('ALTER TABLE "correspondent"."commission_adjustments" ALTER COLUMN adjustment_type TYPE varchar(24);');

    await sequelize.query(`UPDATE "finance"."result_centers" rc SET deleted_at = now()
      WHERE rc.code = 'CORRESPONDENT_COMMISSION' AND rc.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM "finance"."result_centers" older
                    WHERE older.company_id = rc.company_id AND older.code = rc.code AND older.deleted_at IS NULL
                      AND (older.created_at, older.id) < (rc.created_at, rc.id));`);
    await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS result_centers_commission_default_unique
      ON "finance"."result_centers" (company_id, code)
      WHERE code = 'CORRESPONDENT_COMMISSION' AND deleted_at IS NULL;`);

    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await sequelize.query('REVOKE DELETE ON "correspondent"."commission_entitlements" FROM nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await sequelize.query('GRANT DELETE ON "correspondent"."commission_entitlements" TO nayara_runtime;');
    }
    await sequelize.query('DROP INDEX IF EXISTS "finance"."result_centers_commission_default_unique";');
    await sequelize.query('ALTER TABLE "correspondent"."commission_adjustments" DROP CONSTRAINT IF EXISTS commission_adjustments_type_check;');
    await sequelize.query(`ALTER TABLE "correspondent"."commission_adjustments" ADD CONSTRAINT commission_adjustments_type_check CHECK (adjustment_type IN ('CHARGEBACK'));`);
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."commission_entitlements_external_confirmation_unique";');
    await sequelize.query(`CREATE UNIQUE INDEX commission_entitlements_external_confirmation_unique
      ON "correspondent"."commission_entitlements" (company_id, external_confirmation_id) WHERE external_confirmation_id IS NOT NULL;`);
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."commission_entitlements_financial_entry_idx";');
    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      DROP CONSTRAINT IF EXISTS commission_entitlements_status_check, DROP CONSTRAINT IF EXISTS commission_entitlements_amount_check,
      DROP CONSTRAINT IF EXISTS commission_entitlements_percentage_check, DROP CONSTRAINT IF EXISTS commission_entitlements_share_check;`);
  },
};
