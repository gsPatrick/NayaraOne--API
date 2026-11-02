'use strict';

/**
 * Marco 9, M9-D200/D203/D240 (reabertura da compatibilidade com a API antiga) — fecha o legado do Correspondente com gatilhos de somente leitura.
 *
 * Os três gatilhos (provider_accounts, integration_errors, webhook_inbox) NÃO nascem mais nas migrations 650, 656 e 658: a API antiga (Marcos 3 a 8) grava nessas
 * tabelas e quebraria com as migrations 650 a 9963 aplicadas. Esta é a ÚLTIMA migration e só se aplica junto com o deploy da API do Marco 9, que escreve pelo registro
 * de integração (e define app.integration_legacy_write='on' quando precisa gravar no legado). Idempotente (DROP TRIGGER IF EXISTS antes de criar); o down remove os três.
 */
const GATILHOS = [
  {
    tabela: 'provider_accounts',
    eventos: 'INSERT OR UPDATE OR DELETE',
    retorno: 'COALESCE(NEW, OLD)',
    mensagem: 'correspondent.provider_accounts é legado somente leitura: use integration.connections',
  },
  {
    tabela: 'integration_errors',
    eventos: 'INSERT OR UPDATE OR DELETE',
    retorno: 'COALESCE(NEW, OLD)',
    mensagem: 'correspondent.integration_errors é legado somente leitura: use integration.integration_errors',
  },
  {
    tabela: 'webhook_inbox',
    eventos: 'INSERT OR UPDATE',
    retorno: 'NEW',
    mensagem: 'correspondent.webhook_inbox é legado somente leitura: use integration.webhook_inbox',
  },
];

module.exports = {
  GATILHOS,
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const g of GATILHOS) {
      const nome = `${g.tabela}_read_only`;
      await q(`
        CREATE OR REPLACE FUNCTION "correspondent".${nome}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF current_setting('app.integration_legacy_write', true) = 'on' THEN
            RETURN ${g.retorno};
          END IF;
          RAISE EXCEPTION '${g.mensagem}'
            USING ERRCODE = 'restrict_violation';
        END $f$;
      `);
      await q(`DROP TRIGGER IF EXISTS ${nome} ON "correspondent"."${g.tabela}";`);
      await q(`CREATE TRIGGER ${nome} BEFORE ${g.eventos} ON "correspondent"."${g.tabela}"
        FOR EACH ROW EXECUTE FUNCTION "correspondent".${nome}();`);
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const g of GATILHOS) {
      const nome = `${g.tabela}_read_only`;
      await q(`DROP TRIGGER IF EXISTS ${nome} ON "correspondent"."${g.tabela}";`);
      await q(`DROP FUNCTION IF EXISTS "correspondent".${nome}();`);
    }
  },
};
