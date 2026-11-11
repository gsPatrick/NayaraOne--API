'use strict';

/**
 * A.4 do livro ("Chaves estrangeiras multiempresa usarão company_id na chave para impedir vínculos cruzados") e §7 para as
 * demais referências a people.persons (DI-M9I-7): toda FK de uma coluna para people.persons(id) numa tabela com company_id
 * ganha a companheira composta (coluna, company_id) -> people.person_company_links(person_id, company_id). Assim oportunidade,
 * mensagem, contrato, garantia, conta bancária, lançamento, repasse, proprietário de imóvel etc. da empresa B só apontam
 * para pessoa VINCULADA à B (vínculo ativo ou encerrado: o dado antigo continua válido; o vínculo nunca se apaga).
 *
 * Fica de fora: o schema people (migration 20260101010941, com regra de vínculo ativo), a própria people.persons
 * (merged_into_id) e os schemas marketing e construction, que estão com outras esteiras em paralelo (instrução da coordenação
 * de 11/11/2026); a guarda test/people.vinculo.chaves.test.js lista essas FKs uma a uma.
 *
 * Antes de cada constraint, confere os dados existentes, como a 0941: pessoa de OUTRO grupo para a migration sem alterar nada;
 * pessoa do mesmo grupo sem vínculo com a empresa da linha tem o dado preservado e ganha o vínculo ENCERRADO, com auditoria
 * (people.person.link_preserved). A FK simples original continua (com a ação de exclusão dela).
 */
const FORA = ['people', 'marketing', 'construction'];
const nome = (tabela, coluna) => `${`${tabela}_${coluna}`.slice(0, 50)}_vinc_fkey`;

async function referencias(q) {
  const [linhas] = await q(`SELECT n.nspname AS schema, c.relname AS tabela, a.attname AS coluna, con.confdeltype AS ao_excluir
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND con.confrelid = 'people.persons'::regclass AND array_length(con.conkey, 1) = 1
       AND n.nspname NOT IN (:fora)
       AND EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = n.nspname AND x.table_name = c.relname AND x.column_name = 'company_id')
     ORDER BY 1, 2, 3`, { fora: FORA });
  return linhas;
}

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const refs = await referencias(q);
      const tabelas = [...new Set(refs.map((r) => `${r.schema}.${r.tabela}`))];
      // Sem FORCE só durante a conferência (o dono das tabelas não tem BYPASSRLS na homologação).
      for (const t of [...tabelas, 'people.persons', 'people.person_company_links']) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      const relatorio = [];
      for (const r of refs) {
        const t = `${r.schema}.${r.tabela}`;
        const [[outro]] = await q(`SELECT count(*)::int AS n FROM ${t} f JOIN people.persons p ON p.id = f."${r.coluna}"
          JOIN core.companies co ON co.id = f.company_id WHERE p.group_id <> co.group_id`);
        if (outro.n > 0) throw new Error(`${t}.${r.coluna}: ${outro.n} linha(s) apontam para pessoa de OUTRO grupo. Nada foi alterado. Revise esses dados antes de rodar esta migration.`);
        const [pares] = await q(`SELECT f."${r.coluna}" AS person_id, f.company_id, co.group_id, count(*)::int AS linhas FROM ${t} f
          JOIN core.companies co ON co.id = f.company_id
          WHERE f."${r.coluna}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM people.person_company_links l WHERE l.person_id = f."${r.coluna}" AND l.company_id = f.company_id)
          GROUP BY 1, 2, 3`);
        relatorio.push(`${t}.${r.coluna}: ${pares.reduce((s, p) => s + p.linhas, 0)} linha(s) sem vínculo`);
        for (const p of pares) {
          await q(`SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', '', true), set_config('app.vinculo_motivo', :m, true)`, {
            g: p.group_id, c: p.company_id,
            m: `Migration 20260101010944: ${p.linhas} linha(s) de ${t}.${r.coluna} desta empresa apontavam para pessoa cadastrada em outra empresa do grupo. O dado foi preservado; o vínculo foi registrado ENCERRADO, e a pessoa continua invisível para esta empresa até o vínculo ser refeito pelo CPF/CNPJ e nome.`,
          });
          await q(`INSERT INTO people.person_company_links (group_id, company_id, person_id, origin, status, linked_at, ended_at, end_reason)
            VALUES (:g, :c, :p, 'LINKED', 'ENDED', now(), now(), 'Preservação de dado existente (migration 20260101010944).') ON CONFLICT (person_id, company_id) DO NOTHING`,
          { g: p.group_id, c: p.company_id, p: p.person_id });
        }
        // NO ACTION em todas: o vínculo nunca se apaga (só some junto com a pessoa, cuja FK simples original continua valendo,
        // inclusive o SET NULL das três que o têm); NO ACTION é conferido no fim do comando, depois desse SET NULL.
        await q(`ALTER TABLE ${t} ADD CONSTRAINT ${nome(r.tabela, r.coluna)} FOREIGN KEY ("${r.coluna}", company_id)
          REFERENCES people.person_company_links (person_id, company_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT VALID`);
        await q(`ALTER TABLE ${t} VALIDATE CONSTRAINT ${nome(r.tabela, r.coluna)}`);
      }
      await q("SELECT set_config('app.group_id', '', true), set_config('app.company_id', '', true), set_config('app.vinculo_motivo', '', true)");
      console.log(`[20260101010944] conferência antes das chaves compostas (${refs.length} referências): ${relatorio.join('; ')}`);
      for (const t of [...tabelas, 'people.persons', 'people.person_company_links']) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const [linhas] = await q(`SELECT con.conrelid::regclass::text AS tabela, con.conname FROM pg_constraint con
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE con.contype = 'f' AND con.confrelid = 'people.person_company_links'::regclass AND con.conname LIKE '%\\_vinc\\_fkey' AND n.nspname NOT IN (:fora)`, { fora: FORA });
      for (const l of linhas) await q(`ALTER TABLE ${l.tabela} DROP CONSTRAINT IF EXISTS ${l.conname}`);
    });
  },
};
