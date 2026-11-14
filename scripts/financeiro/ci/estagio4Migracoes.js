#!/usr/bin/env node
'use strict';

/**
 * Estágio 4 (db_migrations) da esteira do Financeiro (Marco 4, Guia §17; DoD do Marcelo "Schema/migrations reproduzíveis"). Dentro do cluster descartável
 * da esteira (DATABASE_ADMIN_URL em 127.0.0.1, nunca o .env), cria um banco VAZIO, aplica TODAS as migrations do zero, confere que nenhuma ficou de fora
 * (SequelizeMeta = arquivos de migrations/), reaplica (nenhuma migration nova = idempotente) e confere o schema do Financeiro:
 *   - as 19 entidades do Caderno §5 existem (tabela ou view com o nome literal);
 *   - toda tabela finance.* com company_id tem RLS ligada e FORÇADA e ao menos uma política (exceção única e documentada:
 *     finance.bank_payment_provider_routing, roteamento do webhook bancário só com ids opacos, a mesma de DELIBERATE_NO_RLS_EXCEPTIONS em
 *     test/rls.catalog.allTables.test.js; a exceção só vale enquanto estiver declarada lá);
 *   - as views do §5 são security_invoker (a RLS de origem vale para quem lê);
 *   - o gatilho append-only do ledger (financial_entries) existe;
 *   - nenhuma coluna de dinheiro usa float/real/double (FIN-008).
 * Apaga o banco no final. Sai com 1 ao primeiro problema (FIN_CI_STAGE_FAILED na esteira).
 */
const fs = require('node:fs');
const path = require('node:path');
const { listMigrationFiles } = require('../../../src/config/migrationDirs');
const cluster = require('../../lib/disposableCluster');

const ENTIDADES_DO_LIVRO = ['accounts_chart', 'cost_centers', 'result_centers', 'bank_accounts', 'financial_entries', 'entry_installments', 'ledger', 'bank_transactions',
  'reconciliations', 'approval_requests', 'approval_steps', 'commissions', 'commission_installments', 'owner_repasses', 'security_deposits', 'intercompany_transfers',
  'closing_periods', 'budgets_forecasts', 'anomaly_cases'];
const VIEWS_DO_LIVRO = ['accounts_chart', 'entry_installments', 'ledger', 'security_deposits', 'closing_periods'];
const SEM_RLS_DOCUMENTADA = ['bank_payment_provider_routing'];

function excecoesDeclaradas() {
  const catalogo = fs.readFileSync(path.join(cluster.API_ROOT, 'test', 'rls.catalog.allTables.test.js'), 'utf8');
  return SEM_RLS_DOCUMENTADA.filter((t) => catalogo.includes(`'finance.${t}'`));
}

async function consultar(url, sql) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

async function problemasDoSchema(url) {
  const problemas = [];
  const objetos = await consultar(url, "SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'finance' AND c.relkind IN ('r','v')");
  const porNome = new Map(objetos.map((o) => [o.relname, o]));
  for (const nome of ENTIDADES_DO_LIVRO) if (!porNome.has(nome)) problemas.push(`entidade do §5 ausente: finance.${nome}`);
  for (const nome of VIEWS_DO_LIVRO) {
    const v = porNome.get(nome);
    if (v && v.relkind === 'v' && !(v.reloptions || []).includes('security_invoker=true')) problemas.push(`view finance.${nome} sem security_invoker`);
  }
  const comEmpresa = await consultar(url, "SELECT table_name FROM information_schema.columns WHERE table_schema = 'finance' AND column_name = 'company_id'");
  const politicas = new Set((await consultar(url, "SELECT tablename FROM pg_policies WHERE schemaname = 'finance'")).map((p) => p.tablename));
  const excecoes = excecoesDeclaradas();
  for (const { table_name: t } of comEmpresa) {
    const o = porNome.get(t);
    if (!o || o.relkind !== 'r' || excecoes.includes(t)) continue;
    if (!o.relrowsecurity || !o.relforcerowsecurity) problemas.push(`finance.${t} sem RLS ligada e forçada`);
    if (!politicas.has(t)) problemas.push(`finance.${t} sem política de RLS`);
  }
  const gatilhos = await consultar(url, "SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'finance' AND c.relname = 'financial_entries' AND NOT t.tgisinternal");
  if (!gatilhos.some((g) => /append|immutable|ledger/i.test(g.tgname))) problemas.push('finance.financial_entries sem gatilho append-only do ledger');
  const flutuantes = await consultar(url, "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'finance' AND data_type IN ('real','double precision')");
  for (const f of flutuantes) problemas.push(`coluna de ponto flutuante: finance.${f.table_name}.${f.column_name} (FIN-008 exige numeric)`);
  return { problemas, resumo: { objetos: objetos.length, tabelasComEmpresa: comEmpresa.length, excecoes, gatilhosDoLedger: gatilhos.map((g) => g.tgname) } };
}

async function main() {
  const admin = process.env.DATABASE_ADMIN_URL;
  if (process.env.DISPOSABLE_DB !== '1' || !admin || new URL(admin).hostname !== '127.0.0.1') {
    throw new Error('o estágio 4 só roda dentro do cluster descartável (scripts/withDisposableDb.js): DATABASE_ADMIN_URL em 127.0.0.1');
  }
  const porta = Number(new URL(admin).port);
  const banco = `ci_fin_migr_${Date.now().toString(36)}`;
  // M4-D140: as migrations ficam em migrations/ e em src/modules/finance/infrastructure/db/migrations/ (as duas pastas).
  const arquivos = listMigrationFiles().map((m) => m.name);
  cluster.psql(porta, 'postgres', `CREATE DATABASE ${banco}`);
  try {
    const url = cluster.superUrl(porta, banco);
    const env = cluster.makeChildEnv(cluster.generateKeys())({ DATABASE_URL: url, NODE_ENV: 'development' });
    const t0 = Date.now();
    cluster.mustRun('migrations', 'npx', ['sequelize-cli', 'db:migrate'], env);
    const meta = await consultar(url, 'SELECT name FROM "SequelizeMeta"');
    const registradas = new Set(meta.map((m) => m.name));
    const faltando = arquivos.filter((f) => !registradas.has(f));
    if (faltando.length) throw new Error(`${faltando.length} migration(s) não aplicada(s): ${faltando.slice(0, 5).join(', ')}`);
    console.log(`[estagio 4] ${registradas.size} migrations aplicadas do zero num banco vazio em ${((Date.now() - t0) / 1000).toFixed(1)} s (o repositório tem ${arquivos.length} arquivos; todos aplicados).`);
    const segunda = (cluster.mustRun('reaplicar', 'npx', ['sequelize-cli', 'db:migrate'], env).match(/: migrated \(/g) || []).length;
    if (segunda !== 0) throw new Error(`reaplicar executou ${segunda} migration(s): esperado nenhuma`);
    console.log(`[estagio 4] SequelizeMeta tem as ${registradas.size} migrations; reaplicar não executou nenhuma (idempotente).`);
    const { problemas, resumo } = await problemasDoSchema(url);
    if (problemas.length) throw new Error(`${problemas.length} problema(s) no schema finance:\n- ${problemas.join('\n- ')}`);
    console.log(`[estagio 4] schema finance: as ${ENTIDADES_DO_LIVRO.length} entidades do §5 presentes; ${resumo.objetos} tabelas/views; ${resumo.tabelasComEmpresa} tabelas com company_id, todas com RLS forçada e política (exceção documentada sem RLS: ${resumo.excecoes.map((t) => `finance.${t}`).join(', ') || 'nenhuma'}); views do §5 com security_invoker; gatilho(s) do ledger: ${resumo.gatilhosDoLedger.join(', ')}; nenhuma coluna de ponto flutuante.`);
  } finally {
    cluster.psql(porta, 'postgres', `DROP DATABASE IF EXISTS ${banco} WITH (FORCE)`);
    console.log(`[estagio 4] banco ${banco} apagado.`);
  }
}

main().then(() => console.log('[estagio 4] db_migrations: OK'), (err) => { console.error(`[estagio 4] REPROVADO: ${err.message}`); process.exit(1); });
