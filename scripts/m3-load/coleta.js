'use strict';

/**
 * Leitura do estado do banco DEPOIS da carga do Marco 3, sempre pelo contexto do tenant (RLS da role de runtime): o que ficou gravado
 * de cada fase e o que a empresa B consegue ver da empresa A. As conclusões (violações) ficam em invariantes.js, funções puras.
 */
const { sqlComo } = require('./ambiente');
const { CLOSED_STAGES } = require('../../src/features/crm/opportunities.service');

const vazio = '00000000-0000-0000-0000-000000000000';
const ids = (lista) => (lista.length ? lista : [vazio]);
const n = async (tenant, sql, r) => Number((await sqlComo(tenant, sql, r))[0].n);

/** Notificações "Novo match no Radar" do usuário e a soma dos imóveis que elas anunciam ("Encontramos N imóveis"). */
async function avisosDoRadar(tenant) {
  const avisos = await sqlComo(tenant, "SELECT body FROM core.notifications WHERE user_id = :u AND title = 'Novo match no Radar'", { u: tenant.userId });
  return { notificacoes: avisos.length, imoveisAnunciados: avisos.reduce((soma, a) => soma + Number((/Encontramos (\d+) im/.exec(a.body) || [0, 0])[1]), 0) };
}

/**
 * Um radar: matches repetidos, imóveis com match, eventos e o que foi ANUNCIADO nas notificações criadas durante os reprocessamentos
 * desse radar (diferença das fotos `avisosAntes`/`avisosDepois` tiradas por fases.js; a soma anunciada não pode passar dos matches).
 */
async function coletarRadar(tenant, { tipo, radarId: r, avisosAntes, avisosDepois }) {
  return {
    tipo, radarId: r,
    matchesRepetidos: await sqlComo(tenant, `SELECT property_id, criteria_fingerprint, count(*)::int AS n FROM crm.radar_matches WHERE radar_id = :r
      GROUP BY 1, 2 HAVING count(*) > 1`, { r }),
    imoveisComMatch: await n(tenant, 'SELECT count(DISTINCT property_id) AS n FROM crm.radar_matches WHERE radar_id = :r', { r }),
    eventosMatchCreated: await n(tenant, "SELECT count(*) AS n FROM integration.outbox_events WHERE event_type = 'crm.radar.match.created' AND payload_json->>'radarId' = :r", { r }),
    eventosRadarMatchedPorImovel: await sqlComo(tenant, `SELECT payload_json->>'propertyId' AS property_id, count(*)::int AS n FROM integration.outbox_events
      WHERE event_type = 'radar.matched' AND aggregate_id = :r GROUP BY 1`, { r }),
    notificacoes: avisosDepois.notificacoes - avisosAntes.notificacoes,
    imoveisAnunciados: avisosDepois.imoveisAnunciados - avisosAntes.imoveisAnunciados,
  };
}

async function coletar({ tenantA, tenantB }, rodada, fases) {
  const pessoasA = fases.pessoas.porEmpresa.A.ids;
  return {
    pessoasDaRodada: {
      A: await n(tenantA, "SELECT count(*) AS n FROM people.persons WHERE legal_name LIKE :p", { p: `Carga M3 ${rodada} A %` }),
      B: await n(tenantB, "SELECT count(*) AS n FROM people.persons WHERE legal_name LIKE :p", { p: `Carga M3 ${rodada} B %` }),
    },
    pessoasComOCpfDisputado: await n(tenantA, "SELECT count(*) AS n FROM people.persons WHERE legal_name LIKE :p", { p: `Carga M3 ${rodada} CPF %` }),
    oportunidadesAtivasSemProximaAcao: await n(tenantA, `SELECT count(*) AS n FROM crm.opportunities WHERE person_id IN (:pessoas) AND stage NOT IN (:fechados)
      AND (next_action IS NULL OR btrim(next_action) = '' OR next_action_due_at IS NULL)`, { pessoas: ids(pessoasA), fechados: CLOSED_STAGES }),
    oportunidadesDaRodada: await n(tenantA, 'SELECT count(*) AS n FROM crm.opportunities WHERE person_id IN (:pessoas)', { pessoas: ids(pessoasA) }),
    radares: await Promise.all(fases.radar.radares.map((r) => coletarRadar(tenantA, r))),
    vistoPelaEmpresaB: {
      pessoas: await n(tenantB, 'SELECT count(*) AS n FROM people.persons WHERE id IN (:x)', { x: ids(pessoasA) }),
      oportunidades: await n(tenantB, 'SELECT count(*) AS n FROM crm.opportunities WHERE id IN (:x)', { x: ids(fases.oportunidades.ids) }),
      imoveis: await n(tenantB, 'SELECT count(*) AS n FROM real_estate.properties WHERE id IN (:x)', { x: ids(fases.radar.imoveis) }),
      radarMatches: await n(tenantB, 'SELECT count(*) AS n FROM crm.radar_matches WHERE radar_id IN (:r)', { r: fases.radar.radares.map((r) => r.radarId) }),
    },
  };
}

module.exports = { coletar, avisosDoRadar };
