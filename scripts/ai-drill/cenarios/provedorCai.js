'use strict';

/** Drill (a) do livro: o provider cai. Com candidato seguro o run usa o fallback e o registra; sem candidato seguro falha fechado (503) sem executar tool. */
const FB = require('../../../test/marco9/_helpers/iaFallback');
const { definirParametro } = require('../../../test/marco9/_helpers/iaOrcamento');

const MENSAGEM = 'A NAY não está disponível agora. Nenhuma ação foi executada.';
const principal = FB.linha('prov-a', { pricePerMTokIn: 1, pricePerMTokOut: 1 });
const equivalente = FB.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2 });
const inferior = FB.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2, safetyTier: 2 });

async function cenarioDe(F, tenant, tx, linhas) {
  await definirParametro(tenant, 'ia.fallback.exigir_avaliacao_verde', false, tx);
  const registro = FB.registroFalso(linhas, { falham: { 'prov-a': 'UNAVAILABLE' } });
  return { registro, c: await F.H.cenario(tenant, tx, { deps: FB.depsDoRegistro(registro) }) };
}
const classificar = (F, c) => F.H.rodar(c, 'Classifique [[RESPOSTA:Tipo comercial.]]', { taskType: 'classificar' });

module.exports = {
  id: 'provedor-cai',
  letra: 'a',
  titulo: 'O provedor de modelo cai',
  esperado: 'Com candidato seguro: o run termina pelo fallback e a troca fica registrada. Sem candidato seguro: 503 AI_FALLBACK_UNSAFE, mensagem sem detalhe técnico e nenhuma tool executada.',
  async executar({ F, tenantA, relatorio }) {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      const seguro = await cenarioDe(F, tenantA, tx, [principal, equivalente]);
      const ok = await classificar(F, seguro.c);
      relatorio.confere('com candidato seguro o run termina', ok.ok === true, JSON.stringify(ok.error || null));
      relatorio.confere('o fallback atendeu (provedor B)', ok.provider === 'prov-b', ok.provider);
      const run = await F.H.lerRun(ok.runId, tx);
      relatorio.confere('a troca fica registrada no run (UNAVAILABLE)', run.fallback_trail.length === 1 && run.fallback_trail[0].reason === 'UNAVAILABLE');
      const fechado = await cenarioDe(F, tenantA, tx, [principal, inferior]);
      const falha = await classificar(F, fechado.c);
      relatorio.confere('sem candidato seguro: 503 AI_FALLBACK_UNSAFE', falha.ok === false && falha.error.status === 503 && falha.error.code === 'AI_FALLBACK_UNSAFE', falha.error && falha.error.code);
      relatorio.confere('a mensagem não revela detalhe técnico', falha.error.message === MENSAGEM, falha.error.message);
      relatorio.confere('o candidato inferior nunca foi chamado', fechado.registro.chamadas.every((x) => x.code === 'prov-a'));
      relatorio.confere('nenhuma tool rodou', (await F.H.chamadas(falha.runId, tx)).length === 0);
    });
  },
};
