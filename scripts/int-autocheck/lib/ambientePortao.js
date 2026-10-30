'use strict';

/**
 * Estado do portão de produção por provider (M9-D256) para a condição da pergunta 2. Usa `listReleaseStates` de src/features/integrations/registry/releaseGate.js (providers[].releaseState)
 * em cada empresa do banco. Só abre conexão em banco descartável local (DISPOSABLE_DB=1 e host de loopback); fora dele devolve `consultado: false` com todos os providers do catálogo
 * como pendentes, porque a autochecagem nunca declara liberação que não consultou. Assíncrono: o script consulta antes de calcular (o cálculo em si é síncrono e puro).
 */
const path = require('node:path');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function catalogo(base) {
  process.env.PORT = process.env.PORT || '0';
  const prov = require(path.join(base, 'src/features/integrations/providers/catalog.providers')).SEED_PROVIDERS;
  return { codigos: prov.map((p) => p.code).sort(), dominios: [...new Set(prov.map((p) => p.domain))], dominioDe: new Map(prov.map((p) => [p.code, p.domain])) };
}

const estado = (c, consultado, liberados) => ({
  consultado, familiasTotal: c.dominios.length, familiasLiberadas: new Set([...liberados].map((p) => c.dominioDe.get(p))).size,
  liberados: [...liberados].sort(), naoLiberados: c.codigos.filter((p) => !liberados.has(p)),
});

/** Empresas do banco descartável, lidas com o usuário dono do cluster (DATABASE_ADMIN_URL do withDisposableDb): o usuário do runtime só enxerga a empresa do contexto (RLS). */
async function empresasDoCluster() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || !LOOPBACK.has(new URL(url).hostname)) return null;
  const { Sequelize } = require('sequelize');
  const admin = new Sequelize(url, { dialect: 'postgres', logging: false });
  try { return await admin.query('SELECT id, group_id FROM core.companies', { type: 'SELECT' }); } finally { await admin.close().catch(() => {}); }
}

async function consultarPortao(base) {
  const c = catalogo(base);
  if (process.env.DISPOSABLE_DB !== '1') return estado(c, false, new Set());
  const { sequelize } = require(path.join(base, 'src/models'));
  if (!LOOPBACK.has(String((sequelize.config && sequelize.config.host) || ''))) return estado(c, false, new Set());
  const { listReleaseStates } = require(path.join(base, 'src/features/integrations/registry/releaseGate'));
  const liberados = new Set();
  try {
    const empresas = await empresasDoCluster();
    if (!empresas) return estado(c, false, new Set());
    for (const e of empresas) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: e.group_id }, transaction });
        await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: e.id }, transaction });
        const r = await listReleaseStates({ groupId: e.group_id, companyId: e.id }, transaction);
        r.providers.filter((p) => p.releaseState === 'RELEASED').forEach((p) => liberados.add(p.providerCode));
      });
    }
  } catch (err) {
    return estado(c, false, new Set());
  }
  return estado(c, true, liberados);
}

module.exports = { consultarPortao };
