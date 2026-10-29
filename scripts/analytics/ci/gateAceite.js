#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 14 — aceite dos owners. Em PRODUCAO toda métrica publicada precisa de aceite ACCEPTED da versão atual; em LAB só informa.
 * As métricas vêm de `analytics.metric_definitions` (PUBLISHED) e os aceites de `analytics.metric_acceptance` (M9-D708); enquanto essa tabela
 * não existir, nenhuma métrica tem aceite. Ambiente: --ambiente ou o definido pelo pipeline. Só lê, em banco descartável.
 */
const { bancoDescartavelAtivo } = require('./ambiente');
const { avaliarAceite } = require('./gates/aceite');

const arg = (nome) => { const i = process.argv.indexOf(nome); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  if (!bancoDescartavelAtivo() || !process.env.DATABASE_ADMIN_URL) throw new Error('Recusado: a etapa só lê de banco descartável em 127.0.0.1.');
  const ambiente = arg('--ambiente') || process.env.ANALYTICS_AMBIENTE_PIPELINE || 'LAB';
  const { Sequelize } = require('sequelize');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false, dialect: 'postgres' });
  try {
    const q = (sql) => admin.query(sql, { type: 'SELECT' });
    const metricas = await q(`SELECT d.metric_code AS code, v.version FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.status = 'PUBLISHED' ORDER BY d.metric_code`);
    const [{ existe }] = await q("SELECT to_regclass('analytics.metric_acceptance') IS NOT NULL AS existe");
    const aceites = existe ? await q(`SELECT metric_code AS code, metric_version AS version, status FROM analytics.metric_acceptance`) : [];
    const r = avaliarAceite({ ambiente, metricas, aceites });
    console.log(`ambiente ${ambiente}: ${metricas.length} métrica(s) publicada(s), ${metricas.length - r.pendentes.length} com aceite.`);
    r.pendentes.forEach((p) => console.log(`  pendente: ${p}`));
    if (!r.ok) { console.error(`Reprovada: ${r.pendentes.length} métrica(s) sem aceite do responsável; produção bloqueada.`); process.exitCode = 1; }
  } finally {
    await admin.close();
  }
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
