#!/usr/bin/env node
'use strict';
/**
 * Prova dos renomes de tabela do Marco 5 (caderno §4, M5-D102/M5-D221) num banco DESCARTÁVEL já
 * migrado do zero e com dados: grava uma linha real em cada tabela renomeada, fotografa (OID,
 * linhas, RLS ENABLE/FORCE, policies, GRANTs do nayara_runtime, índices e FKs que apontam para
 * ela), desfaz as migrations do Marco 5 (db:migrate:undo:all --to 20260101009981), confere que o
 * nome ANTIGO voltou com o MESMO OID, as mesmas linhas e as mesmas proteções, refaz tudo
 * (db:migrate) e confere de novo com o nome do livro. Mesmo OID = mesma tabela física: nenhum
 * dado copiado nem perdido.
 *
 *   node scripts/withDisposableDb.js -- node scripts/ci-juridico/renomes-livro.js [--relatorio arquivo.json]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
  console.error('RECUSADO: só em banco descartável (scripts/withDisposableDb.js).');
  process.exit(2);
}
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const RELATORIO = arg('--relatorio');
const PRIMEIRA_M5 = '20260101009981-legal-aprovacao-por-versao-e-arquivo-da-versao.js';

const PARES = [
  { antigo: 'legal.contract_amendments', livro: 'legal.addenda' },
  { antigo: 'legal.legal_case_parties', livro: 'legal.case_parties' },
  { antigo: 'finance.utility_obligations', livro: 'legal.lease_obligations' },
  // A migration 20260101015103 (termo do imóvel usado) grava, para cada empresa sem o modelo, a cláusula TERMO_IMOVEL_USADO sem autor; o
  // down a apaga e o up a grava de novo. Num banco migrado do zero ela não grava nada (ainda não há empresa), no refeito grava uma por
  // empresa: essas linhas são criadas pela migration, não copiadas. Ficam fora da contagem que prova "nada copiado nem perdido" e são
  // contadas à parte (linhasSemeadas), com a assinatura exata da semente.
  { antigo: 'legal.contract_clauses', livro: 'legal.clause_versions', semente: "code = 'TERMO_IMOVEL_USADO' AND created_by IS NULL" },
];
const SEMENTE = Object.fromEntries(PARES.flatMap((p) => (p.semente ? [[p.antigo, p.semente], [p.livro, p.semente]] : [])));

async function foto(c, nome) {
  const r = await c.query(`
    SELECT c.oid::int AS oid, c.relkind::text AS tipo, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants g
        WHERE g.grantee = 'nayara_runtime' AND g.table_schema = n.nspname AND g.table_name = c.relname) AS grants_runtime,
      (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid) AS indices,
      (SELECT string_agg(k.conrelid::regclass::text || '.' || k.conname, ',' ORDER BY 1) FROM pg_constraint k WHERE k.confrelid = c.oid AND k.contype = 'f') AS fks_que_apontam,
      (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS gatilhos
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($1)`, [nome]);
  if (!r.rows[0]) return null;
  const semente = SEMENTE[nome];
  const linhas = await c.query(semente
    ? `SELECT count(*) FILTER (WHERE NOT (${semente}))::int AS n, count(*) FILTER (WHERE ${semente})::int AS s FROM ${nome}`
    : `SELECT count(*)::int AS n FROM ${nome}`);
  return { nome, ...r.rows[0], linhas: linhas.rows[0].n, ...(semente ? { linhasSemeadas: linhas.rows[0].s } : {}) };
}

function cli(...args) {
  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_ADMIN_URL, NODE_ENV: 'development' };
  const r = spawnSync('npx', ['sequelize-cli', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sequelize-cli ${args.join(' ')} falhou:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** Uma linha real por tabela, copiando colunas de uma linha-modelo criada por SQL a partir de dados do seed. */
async function semear(c) {
  const [{ group_id: g, company_id: co, user_id: u }] = (await c.query("SELECT m.group_id, m.company_id, m.user_id FROM core.user_memberships m JOIN core.users x ON x.id = m.user_id WHERE x.email = 'admin@nayaraone.dev' LIMIT 1")).rows;
  const contrato = (await c.query(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, status, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'LEASE_RESIDENTIAL', 'DRAFT', $3, now(), now()) RETURNING id`, [g, co, u])).rows[0].id;
  const pessoa = (await c.query(`INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'PF', 'Pessoa de prova do rename', now(), now()) RETURNING id`, [g, co])).rows[0].id;
  const processo = (await c.query(`INSERT INTO legal.legal_cases (id, group_id, company_id, case_type, status, summary, responsible_user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'LITIGATION', 'OPEN', 'Processo de prova do rename', $3, now(), now()) RETURNING id`, [g, co, u])).rows[0].id;
  await c.query(`INSERT INTO legal.case_parties (id, group_id, company_id, legal_case_id, person_id, party_role, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, 'DEFENDANT', now(), now())`, [g, co, processo, pessoa]);
  await c.query(`INSERT INTO legal.lease_obligations (id, group_id, company_id, contract_id, utility_type, responsible_party, status, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'WATER', 'TENANT', 'PENDING', now(), now())`, [g, co, contrato]);
  await c.query(`INSERT INTO legal.addenda (id, group_id, company_id, contract_id, amendment_number, reason, changes_json, status, effective_from, created_by, created_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 1, 'Aditivo de prova do rename', '{}'::jsonb, 'DRAFT', current_date, $4, now())`, [g, co, contrato, u]);
  const lib = (await c.query(`INSERT INTO legal.clause_library (id, group_id, company_id, code, legal_responsible_user_id, created_by)
    VALUES (gen_random_uuid(), $1, $2, 'PROVA-RENAME', $3, $3) RETURNING id`, [g, co, u])).rows[0].id;
  await c.query(`INSERT INTO legal.clause_versions (id, group_id, company_id, clause_library_id, code, title, body_text, category, version_number, is_active, created_by, created_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'PROVA-RENAME', 'Cláusula de prova', 'Texto da cláusula de prova do rename.', 'GENERAL', 1, true, $4, now())`, [g, co, lib, u]);
  return { contrato, pessoa, processo };
}

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  const rel = { quando: new Date().toISOString(), pares: PARES, etapas: [], erros: [] };
  try {
    try { rel.sementes = await semear(c); } catch (e) { rel.erros.push(`semente: ${e.message}`); }
    const antes = {};
    for (const p of PARES) antes[p.livro] = await foto(c, p.livro);
    rel.etapas.push({ etapa: 'migrado (nome do livro)', fotos: Object.values(antes) });
    cli('db:migrate:undo:all', '--to', PRIMEIRA_M5);
    const desfeito = [];
    for (const p of PARES) {
      const a = antes[p.livro];
      const velho = await foto(c, p.antigo);
      const livroAinda = await c.query('SELECT to_regclass($1) IS NOT NULL AS existe', [p.livro]);
      desfeito.push({ ...p, velho, livroAindaExiste: livroAinda.rows[0].existe });
      if (!velho) { rel.erros.push(`down: ${p.antigo} não voltou`); continue; }
      if (livroAinda.rows[0].existe && p.antigo.split('.')[0] === p.livro.split('.')[0]) rel.erros.push(`down: ${p.livro} continua existindo`);
      for (const k of ['oid', 'linhas', 'rls', 'force', 'policies', 'grants_runtime']) {
        if (a && String(a[k]) !== String(velho[k])) rel.erros.push(`down: ${p.antigo}.${k} ${velho[k]} != ${a[k]}`);
      }
      // FKs de tabelas que o próprio Marco 5 criou (ex.: legal.addendum_signatures) somem no down; as demais ficam.
      const daOrigem = String((a && a.fks_que_apontam) || '').split(',').filter(Boolean);
      const noDown = String(velho.fks_que_apontam || '').split(',').filter(Boolean);
      const perdidas = [];
      for (const fk of daOrigem) {
        const tabela = fk.slice(0, fk.lastIndexOf('.'));
        const existe = (await c.query('SELECT to_regclass($1) IS NOT NULL AS e', [tabela])).rows[0].e;
        if (existe && !noDown.includes(fk)) perdidas.push(fk);
      }
      if (perdidas.length) rel.erros.push(`down: ${p.antigo} perdeu FKs de tabelas que continuam: ${perdidas.join(', ')}`);
    }
    rel.etapas.push({ etapa: `down até ${PRIMEIRA_M5} (nomes antigos)`, fotos: desfeito });
    cli('db:migrate');
    const refeito = [];
    for (const p of PARES) {
      const f = await foto(c, p.livro);
      refeito.push(f);
      const a = antes[p.livro];
      if (!f) { rel.erros.push(`up: ${p.livro} não voltou`); continue; }
      for (const k of ['oid', 'linhas', 'rls', 'force', 'policies', 'grants_runtime', 'indices', 'fks_que_apontam', 'gatilhos']) {
        if (a && String(a[k]) !== String(f[k])) rel.erros.push(`up: ${p.livro}.${k} ${f[k]} != ${a[k]}`);
      }
    }
    const visao = await c.query("SELECT relkind::text AS tipo FROM pg_class WHERE oid = to_regclass('finance.utility_obligations')");
    rel.visaoFinanceUtilityObligations = visao.rows[0] ? visao.rows[0].tipo : 'não existe';
    if (rel.visaoFinanceUtilityObligations !== 'v') rel.erros.push('finance.utility_obligations deveria ser visão');
    rel.etapas.push({ etapa: 'refeito (db:migrate)', fotos: refeito });
  } finally {
    await c.end();
  }
  rel.resultado = rel.erros.length ? 'FALHOU' : 'OK';
  if (RELATORIO) { fs.mkdirSync(path.dirname(RELATORIO), { recursive: true }); fs.writeFileSync(RELATORIO, `${JSON.stringify(rel, null, 1)}\n`); }
  console.log(JSON.stringify({ resultado: rel.resultado, erros: rel.erros, fotos: rel.etapas.map((e) => ({ etapa: e.etapa, fotos: e.fotos })) }, null, 1));
  process.exit(rel.erros.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
