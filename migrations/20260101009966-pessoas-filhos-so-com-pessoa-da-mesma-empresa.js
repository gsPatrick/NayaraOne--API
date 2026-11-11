'use strict';

/**
 * ISO-8 (verificação independente do isolamento do Marco 9, 11/11/2026; DI-M9R-1): dado filho de Pessoa só aponta para pessoa
 * da MESMA empresa.
 *
 * Antes: a FK de person_contacts, person_addresses, person_documents, person_roles e communication_consents para people.persons
 * era só (person_id). No contexto da empresa B, com o papel de runtime sem BYPASSRLS, o banco aceitava um contato (endereço,
 * documento, papel, consentimento) com company_id = B apontando para a pessoa da empresa A do mesmo grupo: a checagem de FK não
 * passa pelo RLS. Livro: A.4 "Chaves estrangeiras multiempresa usarão company_id na chave para impedir vínculos cruzados"; §7
 * "Chaves estrangeiras devem impedir vínculos entre empresas incompatíveis". Nesta versão a pessoa é de uma empresa só
 * (DI-ISO-PESSOAS-1, migration 20260101009965).
 *
 * up:
 * 1. Confere os dados existentes ANTES das constraints (sem FORCE RLS durante a conferência, porque o dono das tabelas não tem
 *    BYPASSRLS na homologação; o estado de FORCE de cada tabela é restaurado no fim). Imprime, por tabela, quantas linhas apontam
 *    para pessoa de outra empresa. Se alguma existir, a migration PARA sem alterar nada (nada some nem muda de empresa: o dado é
 *    de quem decide, não da migration) e a mensagem lista as tabelas e as contagens.
 * 2. UNIQUE (id, company_id) em people.persons (alvo das FKs compostas; id já é PK, então não recusa nenhuma linha).
 * 3. Para cada tabela filha, FK composta (person_id, company_id) -> people.persons (id, company_id), validada, com a mesma ação de
 *    exclusão da FK simples que já existe (que continua).
 *
 * Nomes estáveis, para a migration do vínculo de uma pessoa a várias empresas (branch m9fix/pessoas-vinculo, Marco 3) poder
 * substituir esta: ela remove `<tabela>_person_same_company_fkey` das cinco tabelas e `persons_id_company_same_company_key` antes
 * de criar a FK para person_company_links (com DROP CONSTRAINT IF EXISTS, roda com ou sem esta migration aplicada).
 */
const FILHOS = ['person_contacts', 'person_addresses', 'person_documents', 'person_roles', 'communication_consents'];
const ALVO = 'persons_id_company_same_company_key';
const fk = (t) => `${t}_person_same_company_fkey`;
const ACAO = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

async function forcados(q, tabelas) {
  const [linhas] = await q(`SELECT c.relname, c.relforcerowsecurity AS forcado FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'people' AND c.relname IN (:tabelas)`, { tabelas });
  return Object.fromEntries(linhas.map((l) => [l.relname, l.forcado]));
}

async function acaoAoExcluir(q, tabela) {
  const [[linha]] = await q(`SELECT con.confdeltype AS tipo FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND con.conrelid = ('people.' || :tabela)::regclass AND con.confrelid = 'people.persons'::regclass
      AND array_length(con.conkey, 1) = 1 AND a.attname = 'person_id'`, { tabela });
  if (!linha) throw new Error(`people.${tabela}: FK simples (person_id) -> people.persons não encontrada. Nada foi alterado.`);
  return ACAO[linha.tipo] || 'NO ACTION';
}

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const tabelas = [...FILHOS, 'persons'];
      const estado = await forcados(q, tabelas);
      for (const t of tabelas) if (estado[t]) await q(`ALTER TABLE people.${t} NO FORCE ROW LEVEL SECURITY`);

      const relatorio = [];
      for (const t of FILHOS) {
        const [[n]] = await q(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE p.company_id IS DISTINCT FROM f.company_id)::int AS outra_empresa
          FROM people.${t} f JOIN people.persons p ON p.id = f.person_id`);
        relatorio.push({ tabela: `people.${t}`, linhas: n.total, outraEmpresa: n.outra_empresa });
      }
      const texto = relatorio.map((r) => `${r.tabela}: ${r.outraEmpresa} de ${r.linhas} linha(s) com pessoa de outra empresa`).join('; ');
      const violam = relatorio.filter((r) => r.outraEmpresa > 0);
      if (violam.length > 0) {
        throw new Error(`[20260101009966] PARADA sem alterar nada. Conferência antes das chaves compostas: ${texto}. Cada linha listada aponta para pessoa de outra empresa; decida o destino desses dados (corrigir a empresa da linha ou a pessoa) e rode de novo.`);
      }
      console.log(`[20260101009966] conferência antes das chaves compostas: ${texto}. Nenhuma linha alterada; criando as chaves.`);

      await q(`ALTER TABLE people.persons ADD CONSTRAINT ${ALVO} UNIQUE (id, company_id)`);
      for (const t of FILHOS) {
        const acao = await acaoAoExcluir(q, t);
        await q(`ALTER TABLE people.${t} ADD CONSTRAINT ${fk(t)} FOREIGN KEY (person_id, company_id)
          REFERENCES people.persons (id, company_id) ON UPDATE NO ACTION ON DELETE ${acao} NOT VALID`);
        await q(`ALTER TABLE people.${t} VALIDATE CONSTRAINT ${fk(t)}`);
      }
      for (const t of tabelas) if (estado[t]) await q(`ALTER TABLE people.${t} FORCE ROW LEVEL SECURITY`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of FILHOS) await q(`ALTER TABLE people.${t} DROP CONSTRAINT IF EXISTS ${fk(t)}`);
      await q(`ALTER TABLE people.persons DROP CONSTRAINT IF EXISTS ${ALVO}`);
    });
  },
};

module.exports.FILHOS = FILHOS;
module.exports.ALVO = ALVO;
module.exports.nomeFk = fk;
