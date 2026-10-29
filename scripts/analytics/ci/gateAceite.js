#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 14 — aceite dos owners. Em PRODUCAO toda métrica publicada precisa de aceite ACCEPTED da versão atual, em cada empresa; em LAB só informa.
 * As métricas vêm de `analytics.metric_definitions` (PUBLISHED, a da empresa ou a global) e os aceites da tabela real `analytics.metric_acceptance` (M9-D708),
 * por empresa. Ambiente: --ambiente ou o definido pelo pipeline. Só lê, em banco descartável.
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
    const empresas = await q('SELECT id, group_id FROM core.companies ORDER BY id');
    const publicadas = await q(`SELECT d.metric_code AS code, d.company_id, d.group_id, v.version FROM analytics.metric_definitions d
      JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.status = 'PUBLISHED' ORDER BY d.metric_code`);
    const aceites = await q('SELECT company_id, metric_code AS code, metric_version AS version, status FROM analytics.metric_acceptance');
    const pendentes = [];
    let total = 0;
    for (const empresa of empresas) {
      // por código, a definição da empresa vence a do grupo e a global
      const visiveis = new Map();
      for (const d of publicadas) {
        const rank = d.company_id === empresa.id ? 0 : (d.company_id === null && d.group_id === empresa.group_id ? 1 : (d.company_id === null && d.group_id === null ? 2 : null));
        if (rank !== null && (!visiveis.has(d.code) || rank < visiveis.get(d.code).rank)) visiveis.set(d.code, { rank, code: d.code, version: d.version });
      }
      const metricas = [...visiveis.values()].map(({ code, version }) => ({ code, version }));
      total += metricas.length;
      const r = avaliarAceite({ ambiente, metricas, aceites: aceites.filter((a) => a.company_id === empresa.id) });
      r.pendentes.forEach((p) => pendentes.push(`${p} [empresa ${empresa.id}]`));
    }
    console.log(`ambiente ${ambiente}: ${total} métrica(s) publicada(s) em ${empresas.length} empresa(s), ${total - pendentes.length} com aceite.`);
    pendentes.forEach((p) => console.log(`  pendente: ${p}`));
    if (ambiente === 'PRODUCAO' && pendentes.length) { console.error(`Reprovada: ${pendentes.length} métrica(s) sem aceite do responsável; produção bloqueada.`); process.exitCode = 1; }
  } finally {
    await admin.close();
  }
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
