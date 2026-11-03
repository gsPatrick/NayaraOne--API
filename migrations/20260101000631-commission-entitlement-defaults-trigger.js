'use strict';

/**
 * Compatibilidade durante o deploy: uma API ainda na versão anterior continua gravando direitos de
 * comissão sem os campos novos (provider, fato gerador, split). Este gatilho completa o que faltar
 * com os mesmos valores que o código novo grava: provider do caso, fato gerador "registro manual" e
 * split 100% corretor / 0% gerente.
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      ALTER COLUMN trigger_event SET DEFAULT 'REGISTRO_MANUAL',
      ALTER COLUMN broker_share_pct SET DEFAULT 100,
      ALTER COLUMN manager_share_pct SET DEFAULT 0;`);
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION correspondent.commission_entitlement_defaults() RETURNS trigger AS $$
      BEGIN
        IF NEW.provider_code IS NULL THEN
          SELECT provider_code INTO NEW.provider_code FROM correspondent.financing_cases WHERE id = NEW.financing_case_id;
        END IF;
        IF NEW.broker_amount IS NULL AND NEW.manager_amount IS NULL THEN
          NEW.broker_amount := NEW.amount;
          NEW.manager_amount := 0;
        ELSIF NEW.manager_amount IS NULL THEN
          NEW.manager_amount := NEW.amount - NEW.broker_amount;
        ELSIF NEW.broker_amount IS NULL THEN
          NEW.broker_amount := NEW.amount - NEW.manager_amount;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;`);
    await sequelize.query(`DROP TRIGGER IF EXISTS commission_entitlement_defaults ON "correspondent"."commission_entitlements";`);
    await sequelize.query(`CREATE TRIGGER commission_entitlement_defaults BEFORE INSERT ON "correspondent"."commission_entitlements"
      FOR EACH ROW EXECUTE FUNCTION correspondent.commission_entitlement_defaults();`);
  },
  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP TRIGGER IF EXISTS commission_entitlement_defaults ON "correspondent"."commission_entitlements";');
    await sequelize.query('DROP FUNCTION IF EXISTS correspondent.commission_entitlement_defaults();');
    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      ALTER COLUMN trigger_event DROP DEFAULT, ALTER COLUMN broker_share_pct DROP DEFAULT, ALTER COLUMN manager_share_pct DROP DEFAULT;`);
  },
};
