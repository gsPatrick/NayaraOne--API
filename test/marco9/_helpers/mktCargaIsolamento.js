'use strict';

// Isolamento dos testes de carga do Marketing (M9-D441, não é teste): a carga mede invariantes sobre o que ELA cria, então não pode depender do que outros arquivos deixaram COMMITADO na mesma
// empresa (kill switch ligado, jobs vencidos, fluxos ativos que também consumem o evento). `isolar` neutraliza esse resíduo e `restaurar` devolve exatamente o estado anterior (menos o kill switch,
// que resíduo nenhum deveria manter ligado). Só em banco descartável (usa o superusuário).
const carga = require('./mktCarga');

/** Neutraliza o resíduo da empresa e devolve { restaurar }. `quais`: subconjunto de ['killswitch', 'jobs', 'fluxos']. */
async function isolar(companyId, quais = ['killswitch', 'jobs', 'fluxos']) {
  const parados = { jobs: [], fluxos: [] };
  await carga.withAdmin(async (admin) => {
    if (quais.includes('killswitch')) await admin.query("UPDATE governance.feature_flags SET value = 'false'::jsonb WHERE company_id = $1 AND key LIKE 'marketing.%.kill' AND value = 'true'::jsonb", [companyId]);
    if (quais.includes('jobs')) parados.jobs = (await admin.query("WITH antes AS (SELECT id, status FROM marketing.publication_jobs WHERE company_id = $1 AND status IN ('PENDING', 'UNKNOWN') FOR UPDATE) UPDATE marketing.publication_jobs j SET status = 'CANCELLED' FROM antes WHERE j.id = antes.id RETURNING j.id, antes.status", [companyId])).rows;
    if (quais.includes('fluxos')) parados.fluxos = (await admin.query("UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE company_id = $1 AND status = 'ACTIVE' RETURNING id", [companyId])).rows;
  });
  return {
    parados,
    async restaurar() {
      await carga.withAdmin(async (admin) => {
        for (const j of parados.jobs) await admin.query("UPDATE marketing.publication_jobs SET status = $2 WHERE id = $1 AND status = 'CANCELLED'", [j.id, j.status]);
        if (parados.fluxos.length) await admin.query("UPDATE marketing.automation_flows SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])", [parados.fluxos.map((f) => f.id)]);
      });
    },
  };
}

module.exports = { isolar };
