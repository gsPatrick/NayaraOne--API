'use strict';

/**
 * M9-D046 — carga da NAY com o provider sandbox: várias empresas e pessoas em paralelo, provando zero vazamento entre empresas, zero ultrapassagem de
 * orçamento por concorrência, zero run preso em RUNNING e zero execução duplicada de tool ou de aprovação. Grava de verdade (banco descartável)
 * e aposenta os agentes que criou.
 */
const agents = require('../../src/features/ai/agents');
const { VOLUME_PADRAO } = require('./volume');
const { comoTenant, pessoasDistintas, F } = require('./ambiente');
const { prepararEmpresa, fasePrincipal, faseIsolamento } = require('./orcamentoEIsolamento');
const { faseDuplicidade } = require('./duplicidade');
const inv = require('./invariantes');

const aposentar = (tenant, code) => comoTenant(tenant, (tx) => agents.retire({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, code, 1, tx)).catch(() => null);

async function executarCarga(tenants, volumeParcial = {}) {
  const volume = { ...VOLUME_PADRAO, ...volumeParcial };
  const inicio = Date.now();
  const empresas = [];
  for (const t of tenants) empresas.push(await prepararEmpresa(t, volume));
  const pessoas = await pessoasDistintas(tenants, volume.usuariosPorEmpresa);
  let duplicidade = null;
  try {
    const principais = await fasePrincipal(empresas, pessoas, volume);
    const isolamento = await faseIsolamento(empresas, pessoas);
    duplicidade = await faseDuplicidade(tenants[0], volume);
    const extras = [{ empresa: 0, code: duplicidade.agentCode }];
    const violacoes = {
      vazamento: await inv.vazamentos(empresas, isolamento),
      estouroDeOrcamento: await inv.estouros(empresas, principais, volume),
      runPresoEmRunning: await inv.presos(empresas, extras),
      execucaoDuplicada: inv.duplicados(duplicidade),
    };
    const totais = Object.fromEntries(Object.entries(violacoes).map(([k, v]) => [k, v.length]));
    return {
      volume, empresas: empresas.length, pessoasPorEmpresa: volume.usuariosPorEmpresa,
      execucoes: principais.length + isolamento.length + volume.repeticoesDaToolCall + volume.aceitesSimultaneos,
      aceitosPorEmpresa: empresas.map((_, i) => principais.filter((r) => r.empresa === i && r.ok).length),
      recusadosPorOrcamento: principais.filter((r) => r.code === 'AI_BUDGET_EXHAUSTED').length,
      duplicidade, violacoes, totais, ok: Object.values(totais).every((n) => n === 0), duracaoMs: Date.now() - inicio, executadoEm: new Date().toISOString(),
    };
  } finally {
    for (const e of empresas) await aposentar(e.tenant, e.code);
    if (duplicidade) await aposentar(tenants[0], duplicidade.agentCode);
  }
}

module.exports = { executarCarga, F };
