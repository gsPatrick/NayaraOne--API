'use strict';

/**
 * Drill (f) do livro: o circuito do provedor está aberto. O estado persistido (M9-D217) abre depois de falhas seguidas; o fallback seguro pula o
 * provedor de circuito aberto sem chamá-lo e usa o equivalente; com o circuito fechado o provedor mais barato é o escolhido.
 */
const { IntegrationConnection } = require('../../../src/models');
const breaker = require('../../../src/features/integrations/health/circuitBreaker');
const { readCircuitState } = require('../../../src/features/integrations/health');
const { circuitIsOpen } = require('../../../src/features/ai/providers/fallback/circuit');
const FB = require('../../../test/marco9/_helpers/iaFallback');
const P = require('../../../test/marco9/_helpers/iaProviders');
const { definirParametro } = require('../../../test/marco9/_helpers/iaOrcamento');

const principal = FB.linha('prov-a', { pricePerMTokIn: 1, pricePerMTokOut: 1 });
const barato = FB.linha('openai', { pricePerMTokIn: 2, pricePerMTokOut: 2 });
const seguro = FB.linha('prov-b', { pricePerMTokIn: 3, pricePerMTokOut: 3 });

async function rodar(F, tenant, tx) {
  await definirParametro(tenant, 'ia.fallback.exigir_avaliacao_verde', false, tx);
  const registro = FB.registroFalso([principal, barato, seguro], { falham: { 'prov-a': 'UNAVAILABLE' } });
  const c = await F.H.cenario(tenant, tx, { deps: FB.depsDoRegistro(registro) });
  const r = await F.H.rodar(c, 'Classifique [[RESPOSTA:Tipo comercial.]]', { taskType: 'classificar' });
  return { r, registro };
}

module.exports = {
  id: 'circuito-aberto',
  letra: 'f',
  titulo: 'O circuito de um provedor está aberto',
  esperado: 'Com o circuito aberto o provedor não é chamado e o fallback seguro usa o equivalente; falha ao ler o estado conta como aberto.',
  async executar({ F, tenantA, relatorio }) {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      const conexao = await P.ativarConexao(tenantA, tx, { providerCode: 'openai' });
      relatorio.confere('circuito fechado no início', (await circuitIsOpen('openai', tenantA, tx)) === false);
      const fechado = await rodar(F, tenantA, tx);
      relatorio.confere('circuito fechado: o fallback usa o provedor mais barato', fechado.r.ok === true && fechado.r.provider === 'openai', fechado.r.provider);
      const ctx = { groupId: tenantA.groupId, companyId: tenantA.companyId };
      for (let i = 0; i < 40 && !(await circuitIsOpen('openai', tenantA, tx)); i += 1) {
        await breaker.recordCallResult(await IntegrationConnection.findByPk(conexao.id, { transaction: tx }), ctx, tx, { ok: false, errorClass: 'TRANSIENT' });
      }
      const estado = await readCircuitState(conexao.id, tenantA, tx);
      relatorio.confere('falhas seguidas abrem o circuito persistido', estado.circuitState === 'OPEN', estado.circuitState);
      relatorio.confere('o fallback enxerga o circuito aberto', (await circuitIsOpen('openai', tenantA, tx)) === true);
      const aberto = await rodar(F, tenantA, tx);
      relatorio.confere('circuito aberto: o run termina pelo equivalente seguro', aberto.r.ok === true && aberto.r.provider === 'prov-b', aberto.r.provider || JSON.stringify(aberto.r.error));
      relatorio.confere('o provedor de circuito aberto nunca é chamado', aberto.registro.chamadas.every((x) => x.code !== 'openai'), aberto.registro.chamadas.map((x) => x.code).join(','));
      const run = await F.H.lerRun(aberto.r.runId, tx);
      relatorio.confere('a troca fica registrada no run', run.fallback_trail.length >= 1);
    });
  },
};
