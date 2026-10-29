'use strict';

// Fontes do Jurídico para os testes da M9-D619. Data-base 28/10/2026 (SP).
const bi = require('./biObrasJuridicoEnv');

const at = (day, time = '15:00:00') => `2026-${day}T${time}Z`;

/** Processos: ativos K1 e K2 (EVICTION, HIGH), K3 (LABOR sem risco nem valor); fora: K4 (fase CLOSED, com valor confirmado), K5 excluído, K6 arquivado. */
async function processos(env, t) {
  const c = (extra) => bi.seed(env, t, 'legal.legal_cases', { status: 'OPEN', ...extra });
  const k1 = await c({ case_type: 'EVICTION', risk_level: 'HIGH', estimated_amount: '100000.00', confirmed_amount: '20000.00' });
  const k2 = await c({ case_type: 'EVICTION', risk_level: 'HIGH', estimated_amount: '50000.50' });
  const k3 = await c({ case_type: 'LABOR' });
  const k4 = await c({ case_type: 'LABOR', risk_level: 'LOW', phase: 'CLOSED', estimated_amount: '999.00', confirmed_amount: '7000.00' });
  await c({ case_type: 'LABOR', risk_level: 'CRITICAL', estimated_amount: '5.00', deleted_at: at('10-01') });
  await c({ case_type: 'LABOR', status: 'ARCHIVED', risk_level: 'MEDIUM', estimated_amount: '111.00' });
  return { k1, k2, k3, k4 };
}

/** Prazos abertos: hoje (d1), hoje+6 por um segundo antes da meia-noite de SP (d11), hoje+7 à meia-noite (d12), hoje+29 (d4), hoje+30 (d5), vencidos (d6, d7). */
async function prazos(env, t, caseId) {
  const d = (due, extra = {}) => bi.seed(env, t, 'legal.legal_deadlines', { legal_case_id: caseId, description: 'Contestar', due_at: due, status: 'PENDING', criticality: 'MEDIUM', ...extra });
  const ids = {};
  ids.d1 = await d(at('10-28'));
  ids.d2 = await d(at('11-03'));
  ids.d11 = await d('2026-11-04T02:59:59Z');
  ids.d12 = await d('2026-11-04T03:00:00Z');
  ids.d4 = await d(at('11-26'));
  ids.d5 = await d(at('11-27'));
  ids.d6 = await d(at('10-27'));
  ids.d7 = await d(at('10-18'));
  await d(at('10-01'), { status: 'DONE' });
  await d(at('10-02'), { status: 'CANCELLED' });
  await d(at('10-03'), { deleted_at: at('10-04') });
  return ids;
}

/** Exigências: IDENTIFICATION 3 pendentes em 2 contratos, PROOF_OF_INCOME 1; contrato cancelado e excluído ficam fora. */
async function exigencias(env, t) {
  const contract = (status, extra = {}) => bi.seed(env, t, 'legal.contracts', { contract_type: 'LEASE', status, ...extra });
  const c1 = await contract('ACTIVE');
  const c2 = await contract('DRAFT');
  const c3 = await contract('CANCELLED');
  const c4 = await contract('ACTIVE', { deleted_at: at('10-01') });
  let n = 0;
  const r = (contract_id, requirement_type, status) => bi.seed(env, t, 'legal.contract_requirements', {
    contract_id, requirement_type, status, requirement_code: `REQ_${n += 1}`, description: 'Documento', created_at: at('10-01'), updated_at: at('10-01'),
  });
  const r1 = await r(c1, 'IDENTIFICATION', 'PENDING');
  await r(c1, 'IDENTIFICATION', 'PENDING');
  await r(c1, 'PROOF_OF_INCOME', 'PENDING');
  await r(c1, 'IDENTIFICATION', 'SATISFIED');
  await r(c2, 'IDENTIFICATION', 'PENDING');
  await r(c2, 'PROOF_OF_INCOME', 'WAIVED');
  await r(c3, 'PROOF_OF_INCOME', 'PENDING');
  await r(c4, 'IDENTIFICATION', 'PENDING');
  return { c1, c2, r1 };
}

module.exports = { at, processos, prazos, exigencias };
