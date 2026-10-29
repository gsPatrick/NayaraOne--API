'use strict';

/**
 * M9-D046 — as quatro invariantes da carga (isolamento, orçamento, run preso, execução duplicada). Cada função devolve a lista de violações
 * (vazia = ok), lida do banco com a empresa na sessão; nada é presumido pelo retorno das execuções.
 */
const { comoTenant, F } = require('./ambiente');

const lista = (ids) => `{${ids.join(',')}}`;

/** Isolamento: nenhuma execução leu a oportunidade da outra empresa e cada empresa só enxerga os seus próprios runs. */
async function vazamentos(empresas, resultadosIsolamento) {
  const achados = [];
  for (const r of resultadosIsolamento) {
    if (r.ok && r.answer.includes(r.alheia)) achados.push(`a resposta da empresa ${r.empresa} trouxe a oportunidade da outra empresa`);
    if (r.runId) {
      const sucesso = await comoTenant(empresas[r.empresa].tenant, (tx) => F.q("SELECT 1 FROM ai.tool_calls WHERE run_id = :r AND status = 'SUCCEEDED'", { r: r.runId }, tx));
      if (sucesso.length) achados.push(`o run ${r.runId} executou a tool com id de outra empresa`);
    }
  }
  for (const [i, empresa] of empresas.entries()) {
    const outra = empresas[(i + 1) % empresas.length];
    const vistos = await comoTenant(empresa.tenant, (tx) => F.q('SELECT count(*)::int AS n FROM ai.ai_runs WHERE agent_name = :a', { a: outra.code }, tx));
    if (vistos[0].n > 0) achados.push(`a empresa ${i} enxerga ${vistos[0].n} run(s) do agente da outra empresa`);
  }
  return achados;
}

/** Orçamento: o consumido nunca passa do limite e só o que coube foi aceito; toda recusa é de orçamento. */
async function estouros(empresas, resultadosPrincipais, volume) {
  const achados = [];
  for (const [i, empresa] of empresas.entries()) {
    const [linha] = await comoTenant(empresa.tenant, (tx) => F.q('SELECT consumed_amount::numeric AS consumido, limit_amount::numeric AS limite, reserved_amount::numeric AS reservado FROM ai.budgets WHERE agent_code = :a', { a: empresa.code }, tx));
    if (Number(linha.consumido) + Number(linha.reservado) > Number(linha.limite)) achados.push(`empresa ${i}: consumido ${linha.consumido} + reservado ${linha.reservado} passa do limite ${linha.limite}`);
    const doDia = resultadosPrincipais.filter((r) => r.empresa === i);
    const aceitos = doDia.filter((r) => r.ok).length;
    const cabem = Math.floor(volume.limiteDoOrcamento / volume.custoPorExecucao);
    if (aceitos > cabem) achados.push(`empresa ${i}: ${aceitos} runs aceitos, cabem ${cabem}`);
    if (aceitos < Math.min(cabem, doDia.length)) achados.push(`empresa ${i}: só ${aceitos} aceitos, deveriam caber ${Math.min(cabem, doDia.length)}`);
    doDia.filter((r) => !r.ok && r.code !== 'AI_BUDGET_EXHAUSTED').forEach((r) => achados.push(`empresa ${i}: recusa inesperada ${r.code} ${r.erro || ''}`.trim()));
  }
  return achados;
}

/** Run preso: nenhum run de nenhum agente da carga fica em RUNNING quando tudo terminou. */
async function presos(empresas, codigosExtras = []) {
  const achados = [];
  for (const [i, empresa] of empresas.entries()) {
    const codigos = [empresa.code, ...codigosExtras.filter((c) => c.empresa === i).map((c) => c.code)];
    const r = await comoTenant(empresa.tenant, (tx) => F.q("SELECT id FROM ai.ai_runs WHERE agent_name = ANY(CAST(:c AS text[])) AND status = 'RUNNING'", { c: lista(codigos) }, tx));
    r.forEach((x) => achados.push(`empresa ${i}: run ${x.id} preso em RUNNING`));
  }
  return achados;
}

/** Execução duplicada: uma proposta, uma linha de tool call, uma execução de aprovação e um pagamento. */
function duplicados(d) {
  const achados = [];
  if (d.propostas !== 1) achados.push(`${d.propostas} propostas para a mesma tool call`);
  if (d.linhasDeToolCall !== 1) achados.push(`${d.linhasDeToolCall} linhas de tool call para a mesma chamada`);
  if (d.execucoesReais !== 1) achados.push(`${d.execucoesReais} execuções reais da mesma aprovação`);
  if (d.pagamentos !== 1) achados.push(`${d.pagamentos} pagamentos para a mesma aprovação`);
  if (d.aceitesConcluidos !== d.aceitesEnviados) achados.push(`${d.aceitesEnviados - d.aceitesConcluidos} aceites recusados: ${d.recusados.join(',')}`);
  return achados;
}

module.exports = { vazamentos, estouros, presos, duplicados };
