'use strict';

/**
 * Dado filho de Pessoa só aponta para pessoa VINCULADA à empresa do dado (ISO-8; DI-M9I-7).
 *
 * Livro: A.4 "Chaves estrangeiras multiempresa usarão company_id na chave para impedir vínculos cruzados"; §7 "Chaves
 * estrangeiras devem impedir vínculos entre empresas incompatíveis". Antes, a FK desses filhos para people.persons era só
 * (person_id): no contexto da empresa B, o banco aceitava contato, endereço, documento, papel e consentimento de B apontando
 * para a pessoa da empresa A (a checagem de FK não passa pelo RLS).
 *
 * Para cada tabela filha (person_contacts, person_addresses, person_documents, person_roles, communication_consents):
 * 1. Confere os dados existentes ANTES da constraint: linha cujo (person_id, company_id) não tem vínculo. Relata a contagem por
 *    tabela (saída da migration). Pessoa de OUTRO grupo (impossível pelo RLS de grupo): a migration PARA e nada é alterado.
 *    Pessoa do mesmo grupo: o dado é preservado, nada se apaga nem se move; cria-se o vínculo ENCERRADO (status ENDED, origem
 *    LINKED) para a empresa do dado, com auditoria (people.person.link_preserved em audit.audit_log, motivo com a tabela e a
 *    contagem). Encerrado = a empresa continua sem ver a pessoa; reabrir é o fluxo normal de vínculo (CPF/CNPJ e nome).
 * 2. FK composta (person_id, company_id) -> person_company_links(person_id, company_id), validada.
 * 3. Política RESTRICTIVE de INSERT e UPDATE: o vínculo daquela empresa precisa estar ACTIVE (vínculo desfeito não recebe dado
 *    novo). As políticas de leitura por empresa (tenant_isolation) não mudam.
 * As unicidades dos filhos por pessoa E empresa ficam na migration 20260101010943.
 */
const FILHOS = ['person_contacts', 'person_addresses', 'person_documents', 'person_roles', 'communication_consents'];
const VINCULO_ATIVO = (t) => `EXISTS (SELECT 1 FROM people.person_company_links l
  WHERE l.person_id = ${t}.person_id AND l.company_id = ${t}.company_id AND l.status = 'ACTIVE')`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const relatorio = [];
      // Sem FORCE só durante a conferência: o dono das tabelas não tem BYPASSRLS na homologação e precisa ver todas as empresas.
      for (const t of [...FILHOS, 'persons', 'person_company_links']) await q(`ALTER TABLE people.${t} NO FORCE ROW LEVEL SECURITY`);

      for (const t of FILHOS) {
        const [[outroGrupo]] = await q(`SELECT count(*)::int AS n FROM people.${t} f JOIN people.persons p ON p.id = f.person_id
          WHERE p.group_id <> f.group_id`);
        if (outroGrupo.n > 0) {
          throw new Error(`people.${t}: ${outroGrupo.n} linha(s) apontam para pessoa de OUTRO grupo. Nada foi alterado. Revise esses dados antes de rodar esta migration.`);
        }
        const [pares] = await q(`SELECT f.person_id, f.company_id, f.group_id, count(*)::int AS linhas FROM people.${t} f
          WHERE NOT EXISTS (SELECT 1 FROM people.person_company_links l WHERE l.person_id = f.person_id AND l.company_id = f.company_id)
          GROUP BY 1, 2, 3`);
        const linhas = pares.reduce((s, p) => s + p.linhas, 0);
        relatorio.push({ tabela: `people.${t}`, linhasSemVinculo: linhas, pares: pares.length });
        for (const p of pares) {
          await q(`SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', '', true),
            set_config('app.vinculo_motivo', :m, true)`, {
            g: p.group_id, c: p.company_id,
            m: `Migration 20260101010941: ${p.linhas} linha(s) de people.${t} desta empresa apontavam para pessoa cadastrada em outra empresa do grupo. O dado foi preservado; o vínculo foi registrado ENCERRADO, e a pessoa continua invisível para esta empresa até o vínculo ser refeito pelo CPF/CNPJ e nome.`,
          });
          await q(`INSERT INTO people.person_company_links (group_id, company_id, person_id, origin, status, linked_at, ended_at, end_reason)
            VALUES (:g, :c, :p, 'LINKED', 'ENDED', now(), now(), 'Preservação de dado existente (migration 20260101010941).')
            ON CONFLICT (person_id, company_id) DO NOTHING`, { g: p.group_id, c: p.company_id, p: p.person_id });
        }
      }
      await q("SELECT set_config('app.group_id', '', true), set_config('app.company_id', '', true), set_config('app.vinculo_motivo', '', true)");
      const texto = relatorio.map((r) => `${r.tabela}: ${r.linhasSemVinculo} linha(s) sem vínculo em ${r.pares} par(es) pessoa/empresa`).join('; ');
      console.log(`[20260101010941] conferência antes das chaves compostas: ${texto}`);

      // Integração com o Marco 9: a migration 20260101009966 (ISO-8 do Marco 9) criou <filho>_person_same_company_fkey, a chave composta
      // para people.persons (id, company_id) — o filho só da empresa da pessoa. O vínculo SUBSTITUI essa chave pela chave para o vínculo
      // (a empresa vinculada grava os próprios filhos da pessoa); a 9966 deixou os nomes estáveis para isso. A UNIQUE (id, company_id) de
      // people.persons fica (id já é a chave primária: não recusa nada e não quebra quem dependa dela).
      for (const t of FILHOS) await q(`ALTER TABLE people.${t} DROP CONSTRAINT IF EXISTS ${t}_person_same_company_fkey`);
      for (const t of FILHOS) {
        await q(`ALTER TABLE people.${t} ADD CONSTRAINT ${t}_person_company_link_fkey FOREIGN KEY (person_id, company_id)
          REFERENCES people.person_company_links (person_id, company_id) ON UPDATE NO ACTION ON DELETE RESTRICT NOT VALID`);
        await q(`ALTER TABLE people.${t} VALIDATE CONSTRAINT ${t}_person_company_link_fkey`);
        await q(`CREATE INDEX IF NOT EXISTS ${t}_person_company_idx ON people.${t} (person_id, company_id)`);
        await q(`CREATE POLICY ${t}_pessoa_vinculada_insert ON people.${t} AS RESTRICTIVE FOR INSERT WITH CHECK (${VINCULO_ATIVO(t)})`);
        await q(`CREATE POLICY ${t}_pessoa_vinculada_update ON people.${t} AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (${VINCULO_ATIVO(t)})`);
      }
      for (const t of [...FILHOS, 'persons', 'person_company_links']) await q(`ALTER TABLE people.${t} FORCE ROW LEVEL SECURITY`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of FILHOS) {
        await q(`DROP POLICY IF EXISTS ${t}_pessoa_vinculada_update ON people.${t}`);
        await q(`DROP POLICY IF EXISTS ${t}_pessoa_vinculada_insert ON people.${t}`);
        await q(`DROP INDEX IF EXISTS people.${t}_person_company_idx`);
        await q(`ALTER TABLE people.${t} DROP CONSTRAINT IF EXISTS ${t}_person_company_link_fkey`);
      }
      // Os vínculos ENCERRADOS criados na conferência ficam na tabela de vínculos, que a migration anterior remove no down dela.
      // Volta a chave do Marco 9 (9966) quando ela está aplicada (a UNIQUE alvo existe): criada NOT VALID e validada se nenhum filho de
      // outra empresa ficou de quando o vínculo valia; senão fica sem validar (o dado não é apagado pela migration).
      const [[alvo]] = await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'persons_id_company_same_company_key'");
      if (alvo.n) {
        for (const t of FILHOS) {
          const [[existe]] = await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = '${t}_person_same_company_fkey'`);
          if (existe.n) continue;
          // Mesma ação de exclusão da FK simples (person_id) -> people.persons, como na 9966.
          const [[simples]] = await q(`SELECT con.confdeltype AS tipo FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
            WHERE con.contype = 'f' AND con.conrelid = 'people.${t}'::regclass AND con.confrelid = 'people.persons'::regclass
              AND array_length(con.conkey, 1) = 1 AND a.attname = 'person_id'`);
          const acao = ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[simples && simples.tipo] || 'NO ACTION';
          await q(`ALTER TABLE people.${t} ADD CONSTRAINT ${t}_person_same_company_fkey FOREIGN KEY (person_id, company_id)
            REFERENCES people.persons (id, company_id) ON UPDATE NO ACTION ON DELETE ${acao} NOT VALID`);
          const [[cruzadas]] = await q(`SELECT count(*)::int AS n FROM people.${t} f JOIN people.persons p ON p.id = f.person_id WHERE p.company_id IS DISTINCT FROM f.company_id`);
          if (!cruzadas.n) await q(`ALTER TABLE people.${t} VALIDATE CONSTRAINT ${t}_person_same_company_fkey`);
        }
      }
    });
  },
};
