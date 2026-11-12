'use strict';

/**
 * Rodada 4 da verificação independente do Marco 9 (12/11/2026; DI-M9R-10): o id externo da mensagem do CRM sem connection passa a ser único
 * POR EMPRESA, não no banco inteiro.
 *
 * Antes: `crm_messages_external_id_legacy_uq` (migration 675) era UNIQUE (external_message_id) quando connection_id é nulo, valendo para
 * todas as empresas. A empresa B que gravava `POST /messages` com o `externalMessageId` de uma mensagem da empresa A recebia 409
 * `UNIQUE_CONSTRAINT_VIOLATION`: ficava sabendo que o id existe em outra empresa e, no sentido contrário, A ficava impedida de usar o id que
 * B usou. Livro: Marco 3 §10 "externalMessageId/provider deve ser único quando existir para evitar interação duplicada"; A.4 "Chaves
 * estrangeiras multiempresa usarão company_id na chave". O índice com connection (`crm_messages_connection_external_uq`, connection_id e
 * external_message_id) não muda: a connection já é de uma empresa só.
 *
 * up:
 * 1. Confere os dados ANTES (sem FORCE RLS durante a conferência, porque o dono das tabelas não tem BYPASSRLS na homologação; o estado de FORCE
 *    é restaurado no fim). Imprime quantas mensagens têm id externo sem connection, em quantas empresas, e quantos ids se repetem na mesma
 *    empresa. Com o índice global de hoje não há repetição; se houver (índice removido à mão), PARA sem alterar nada.
 * 2. Troca o índice global pelo índice por empresa `crm_messages_company_external_id_uq` (company_id, external_message_id), com o mesmo filtro.
 * down: confere se algum id externo sem connection é usado por mais de uma empresa (o que o índice por empresa permite). Se houver, PARA sem
 * alterar nada e informa as contagens: o índice global não volta sem que alguém decida o destino dessas mensagens. Senão, volta o índice global.
 */
const TABELA = 'crm.messages';
const GLOBAL = 'crm_messages_external_id_legacy_uq';
const POR_EMPRESA = 'crm_messages_company_external_id_uq';
const FILTRO = 'external_message_id IS NOT NULL AND connection_id IS NULL';

async function forcado(q) {
  const [[l]] = await q("SELECT relforcerowsecurity AS forcado FROM pg_class WHERE oid = 'crm.messages'::regclass");
  return l.forcado;
}

/** Roda `fn` com o FORCE RLS da tabela desligado (o dono enxerga todas as empresas) e o restaura no fim; erro desfaz tudo (transação). */
async function semForce(q, fn) {
  const estava = await forcado(q);
  if (estava) await q(`ALTER TABLE ${TABELA} NO FORCE ROW LEVEL SECURITY`);
  await fn();
  if (estava) await q(`ALTER TABLE ${TABELA} FORCE ROW LEVEL SECURITY`);
}

/** Contagens da conferência: mensagens com id externo sem connection, empresas, ids repetidos na mesma empresa e ids usados por mais de uma. */
async function conferir(q) {
  const [[r]] = await q(`WITH m AS (SELECT company_id, external_message_id FROM ${TABELA} WHERE ${FILTRO})
    SELECT (SELECT count(*) FROM m)::int AS mensagens,
      (SELECT count(DISTINCT company_id) FROM m)::int AS empresas,
      (SELECT count(*) FROM (SELECT 1 FROM m GROUP BY company_id, external_message_id HAVING count(*) > 1) d)::int AS repetidos_na_empresa,
      (SELECT count(*) FROM (SELECT 1 FROM m GROUP BY external_message_id HAVING count(DISTINCT company_id) > 1) d)::int AS ids_em_mais_de_uma_empresa,
      (SELECT count(*) FROM m WHERE external_message_id IN (SELECT external_message_id FROM m GROUP BY external_message_id HAVING count(DISTINCT company_id) > 1))::int AS mensagens_em_ids_compartilhados`);
  return r;
}

const descrever = (r) => `crm.messages: ${r.mensagens} mensagem(ns) com id externo sem connection, em ${r.empresas} empresa(s); `
  + `${r.repetidos_na_empresa} id(s) repetido(s) na mesma empresa; ${r.ids_em_mais_de_uma_empresa} id(s) usado(s) por mais de uma empresa `
  + `(${r.mensagens_em_ids_compartilhados} mensagem(ns))`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await semForce(q, async () => {
        const r = await conferir(q);
        if (r.repetidos_na_empresa > 0) {
          throw new Error(`[20260101009976] PARADA sem alterar nada. Conferência antes do índice por empresa: ${descrever(r)}. Cada id repetido na mesma empresa é uma interação duplicada; decida qual mensagem fica com o id e rode de novo.`);
        }
        console.log(`[20260101009976] conferência antes do índice por empresa: ${descrever(r)}. Nenhuma linha alterada; trocando o índice global pelo índice por empresa.`);
        await q(`DROP INDEX IF EXISTS crm.${POR_EMPRESA}`); // idempotente: rodar de novo recria o mesmo índice
        await q(`CREATE UNIQUE INDEX ${POR_EMPRESA} ON ${TABELA} (company_id, external_message_id) WHERE ${FILTRO}`);
        await q(`DROP INDEX IF EXISTS crm.${GLOBAL}`);
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await semForce(q, async () => {
        const r = await conferir(q);
        if (r.ids_em_mais_de_uma_empresa > 0) {
          throw new Error(`[20260101009976] PARADA sem alterar nada. Conferência antes de voltar ao índice global: ${descrever(r)}. O índice global recusaria esses ids; decida o destino dessas mensagens (ou restaure o backup) e rode de novo.`);
        }
        console.log(`[20260101009976] conferência antes de voltar ao índice global: ${descrever(r)}. Nenhuma linha alterada; voltando ao índice global.`);
        await q(`DROP INDEX IF EXISTS crm.${GLOBAL}`);
        await q(`CREATE UNIQUE INDEX ${GLOBAL} ON ${TABELA} (external_message_id) WHERE ${FILTRO}`);
        await q(`DROP INDEX IF EXISTS crm.${POR_EMPRESA}`);
      });
    });
  },
};

module.exports.GLOBAL = GLOBAL;
module.exports.POR_EMPRESA = POR_EMPRESA;
