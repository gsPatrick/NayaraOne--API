'use strict';

/**
 * ISO-R2 (verificação independente do Marco 9, rodada 3, 12/11/2026; DI-M9R-6): a mensagem do CRM só aponta para conversa e para mídia em
 * quarentena da MESMA empresa.
 *
 * Antes: crm.messages.conversation_id tinha FK simples para crm.conversations(id) (migration 679) e media_quarantine_id não tinha FK nenhuma.
 * A checagem de FK não passa pelo RLS: no contexto da empresa B do mesmo grupo, o banco aceitava a mensagem de B com a conversa da empresa A.
 * Livro: A.4 "Chaves estrangeiras multiempresa usarão company_id na chave para impedir vínculos cruzados"; §7 "Chaves estrangeiras devem
 * impedir vínculos entre empresas incompatíveis". Mesmo padrão da 20260101009966.
 *
 * up:
 * 1. Confere os dados existentes ANTES das constraints (sem FORCE RLS durante a conferência, porque o dono das tabelas não tem BYPASSRLS na
 *    homologação; o estado de FORCE de cada tabela é restaurado no fim). Imprime quantas mensagens apontam para conversa de outra empresa e
 *    quantas apontam para mídia de outra empresa ou inexistente (sem FK até aqui). Se alguma existir, PARA sem alterar nada e informa as
 *    contagens: o destino desses dados é de quem decide, não da migration.
 * 2. UNIQUE (id, company_id) em crm.conversations e em files.quarantine (alvos das FKs compostas; id já é PK, não recusa nenhuma linha).
 * 3. FKs compostas, validadas:
 *    - (conversation_id, company_id) -> crm.conversations (id, company_id), ON DELETE SET NULL (conversation_id): a mesma ação da FK simples
 *      da 679, que continua; só a conversa é anulada, a empresa da mensagem fica;
 *    - (media_quarantine_id, company_id) -> files.quarantine (id, company_id), ON DELETE NO ACTION: a linha da quarentena nunca é apagada
 *      (migration 691), então nada a anular.
 * Exige PostgreSQL 15 ou mais novo (SET NULL com lista de colunas); homologação e CI estão no 16/17.
 */
const ALVOS = [
  { tabela: 'crm.conversations', unique: 'conversations_id_company_same_company_key' },
  { tabela: 'files.quarantine', unique: 'quarantine_id_company_same_company_key' },
];
const FK_CONVERSA = 'messages_conversation_same_company_fkey';
const FK_MIDIA = 'messages_media_quarantine_same_company_fkey';
const TABELAS = ['crm.messages', ...ALVOS.map((a) => a.tabela)];

async function forcados(q) {
  const [linhas] = await q(`SELECT n.nspname || '.' || c.relname AS tabela, c.relforcerowsecurity AS forcado FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname || '.' || c.relname) IN (:tabelas)`, { tabelas: TABELAS });
  return Object.fromEntries(linhas.map((l) => [l.tabela, l.forcado]));
}

/** Contagens da conferência: mensagens com conversa de outra empresa; com mídia de outra empresa; com mídia que não existe. */
async function conferir(q) {
  const [[c]] = await q(`SELECT count(*)::int AS com_conversa,
      count(*) FILTER (WHERE cv.company_id IS DISTINCT FROM m.company_id)::int AS outra_empresa
    FROM crm.messages m JOIN crm.conversations cv ON cv.id = m.conversation_id`);
  const [[mq]] = await q(`SELECT count(*)::int AS com_midia,
      count(*) FILTER (WHERE fq.id IS NOT NULL AND fq.company_id IS DISTINCT FROM m.company_id)::int AS outra_empresa,
      count(*) FILTER (WHERE fq.id IS NULL)::int AS inexistente
    FROM crm.messages m LEFT JOIN files.quarantine fq ON fq.id = m.media_quarantine_id WHERE m.media_quarantine_id IS NOT NULL`);
  return {
    conversaOutraEmpresa: c.outra_empresa, comConversa: c.com_conversa,
    midiaOutraEmpresa: mq.outra_empresa, midiaInexistente: mq.inexistente, comMidia: mq.com_midia,
  };
}

/** Remove as duas FKs compostas e depois os UNIQUE de apoio (as FKs dependem deles). A FK simples da 679 não é tocada. */
async function removerChaves(q) {
  await q(`ALTER TABLE crm.messages DROP CONSTRAINT IF EXISTS ${FK_MIDIA}`);
  await q(`ALTER TABLE crm.messages DROP CONSTRAINT IF EXISTS ${FK_CONVERSA}`);
  for (const a of ALVOS) await q(`ALTER TABLE ${a.tabela} DROP CONSTRAINT IF EXISTS ${a.unique}`);
}

const descrever = (r) => `crm.messages.conversation_id: ${r.conversaOutraEmpresa} de ${r.comConversa} mensagem(ns) com conversa de outra empresa; `
  + `crm.messages.media_quarantine_id: ${r.midiaOutraEmpresa} de ${r.comMidia} com mídia de outra empresa e ${r.midiaInexistente} com mídia inexistente`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const estado = await forcados(q);
      for (const t of TABELAS) if (estado[t]) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);

      const r = await conferir(q);
      const texto = descrever(r);
      if (r.conversaOutraEmpresa + r.midiaOutraEmpresa + r.midiaInexistente > 0) {
        throw new Error(`[20260101009971] PARADA sem alterar nada. Conferência antes das chaves compostas: ${texto}. Cada mensagem contada aponta para conversa ou mídia fora da empresa dela; decida o destino desses dados (corrigir a referência ou a empresa da mensagem) e rode de novo.`);
      }
      console.log(`[20260101009971] conferência antes das chaves compostas: ${texto}. Nenhuma linha alterada; criando as chaves.`);

      await removerChaves(q); // idempotente: rodar de novo recria as mesmas chaves
      for (const a of ALVOS) await q(`ALTER TABLE ${a.tabela} ADD CONSTRAINT ${a.unique} UNIQUE (id, company_id)`);
      await q(`ALTER TABLE crm.messages ADD CONSTRAINT ${FK_CONVERSA} FOREIGN KEY (conversation_id, company_id)
        REFERENCES crm.conversations (id, company_id) ON UPDATE NO ACTION ON DELETE SET NULL (conversation_id) NOT VALID`);
      await q(`ALTER TABLE crm.messages VALIDATE CONSTRAINT ${FK_CONVERSA}`);
      await q(`ALTER TABLE crm.messages ADD CONSTRAINT ${FK_MIDIA} FOREIGN KEY (media_quarantine_id, company_id)
        REFERENCES files.quarantine (id, company_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT VALID`);
      await q(`ALTER TABLE crm.messages VALIDATE CONSTRAINT ${FK_MIDIA}`);
      for (const t of TABELAS) if (estado[t]) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await removerChaves((sql) => queryInterface.sequelize.query(sql, { transaction }));
    });
  },
};

module.exports.ALVOS = ALVOS;
module.exports.FK_CONVERSA = FK_CONVERSA;
module.exports.FK_MIDIA = FK_MIDIA;
