#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 14 — aceite dos owners. Em PRODUCAO toda métrica publicada precisa de aceite ACCEPTED da versão atual, em cada empresa (e sem
 * métrica publicada não há o que liberar). Em LAB não reprova pelo aceite e imprime a linha `REGISTRO:` com a pendência adiada para o Marco 10
 * (decisão da cliente de 16/11/2026, gates/aceite.js), que a esteira copia para o resumo.json.
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
    // uma só decisão para todas as empresas: o código leva a empresa, e o aceite só vale para a empresa dele
    const metricas = [];
    for (const empresa of empresas) {
      // por código, a definição da empresa vence a do grupo e a global
      const visiveis = new Map();
      for (const d of publicadas) {
        const rank = d.company_id === empresa.id ? 0 : (d.company_id === null && d.group_id === empresa.group_id ? 1 : (d.company_id === null && d.group_id === null ? 2 : null));
        if (rank !== null && (!visiveis.has(d.code) || rank < visiveis.get(d.code).rank)) visiveis.set(d.code, { rank, code: d.code, version: d.version });
      }
      for (const { code, version } of visiveis.values()) metricas.push({ code: `${code} [empresa ${empresa.id}]`, version });
    }
    const r = avaliarAceite({ ambiente, metricas, aceites: aceites.map((a) => ({ ...a, code: `${a.code} [empresa ${a.company_id}]` })) });
    console.log(`ambiente ${ambiente}: ${metricas.length} métrica(s) publicada(s) em ${empresas.length} empresa(s), ${metricas.length - r.pendentes.length} com aceite.`);
    r.pendentes.forEach((p) => console.log(`  pendente: ${p}`));
    if (r.registro) console.log(`REGISTRO: ${r.registro}`);
    if (!r.ok) { console.error(`Reprovada: ${r.problemas.length === r.pendentes.length ? `${r.pendentes.length} métrica(s) sem aceite do responsável` : r.problemas.join(' ')}; produção bloqueada.`); process.exitCode = 1; }
  } finally {
    await admin.close();
  }
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
