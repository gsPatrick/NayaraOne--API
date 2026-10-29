'use strict';

/**
 * M9-D046 — fases 1 e 2 da carga: (1) várias empresas e pessoas rodando a NAY ao mesmo tempo contra um orçamento que só comporta parte dos runs;
 * (2) o mesmo, com pedidos que tentam ler a oportunidade da OUTRA empresa. Cada run usa a sua própria transação com commit (conexões de verdade).
 */
const { comoTenant, F } = require('./ambiente');
const { PERMS } = require('../../test/marco9/_helpers/iaOrquestrador');

async function prepararEmpresa(tenant, volume) {
  return comoTenant(tenant, async (tx) => {
    const c = await F.H.cenario(tenant, tx, { limit: `${volume.limiteDoOrcamento}.00` });
    return { tenant, code: c.code, registry: c.registry, orch: c.orch, oppId: c.opp.id, auth: c.auth };
  });
}

const authDe = (empresa, userId) => ({ ...empresa.auth, userId, permissions: PERMS });

/** Uma execução em transação própria. Devolve { ok, status, code, runId, answer }. */
function executar(empresa, userId, texto) {
  return comoTenant(empresa.tenant, (tx) => empresa.orch.run(
    { agentCode: empresa.code, purpose: 'Carga da NAY', input: texto, taskType: 'classificar' }, authDe(empresa, userId), tx
  )).then((r) => ({ ok: r.ok === true, status: r.status, code: r.error && r.error.code, runId: r.runId, answer: String(r.answer || '') }), (e) => ({ ok: false, status: 'THROWN', code: e.code || 'THROWN', runId: null, answer: '', erro: e.message }));
}

/** Fase 1: todas as empresas e pessoas em paralelo, cada run gasta `custoPorExecucao`. */
async function fasePrincipal(empresas, pessoas, volume) {
  const pedidos = [];
  empresas.forEach((empresa, i) => pessoas[i].forEach((userId) => {
    for (let k = 0; k < volume.execucoesPorUsuario; k += 1) pedidos.push(executar(empresa, userId, `Classifique o pedido ${k} [[CUSTO:${volume.custoPorExecucao}]] [[RESPOSTA:Tipo comercial ${k}.]]`).then((r) => ({ ...r, empresa: i })));
  }));
  return Promise.all(pedidos);
}

/** Fase 2: pessoas de cada empresa pedem a oportunidade da outra empresa; nenhuma pode receber o dado. */
async function faseIsolamento(empresas, pessoas) {
  const pedidos = [];
  empresas.forEach((empresa, i) => {
    const alheia = empresas[(i + 1) % empresas.length];
    pessoas[i].forEach((userId) => pedidos.push(
      executar(empresa, userId, `Consulte [[TOOL:crm.getOpportunity:{"opportunityId":"${alheia.oppId}"}]] [[RESPOSTA:ok]]`).then((r) => ({ ...r, empresa: i, alheia: alheia.oppId }))
    ));
  });
  return Promise.all(pedidos);
}

module.exports = { prepararEmpresa, fasePrincipal, faseIsolamento, executar };
