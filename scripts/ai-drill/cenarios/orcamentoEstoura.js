'use strict';

/** Drill (b) do livro: o orçamento estoura. A 90% o agente não crítico só usa regra, cache e modelo pequeno; a 100% tudo que gasta recebe 429; a regra de custo zero segue. */
const { rejeita } = require('../../../test/marco9/_helpers/iaOrcamento');

async function recusado(relatorio, nome, promessa) {
  try {
    const err = await rejeita(promessa, 429, 'AI_BUDGET_EXHAUSTED');
    relatorio.confere(nome, true, err.code);
    return err;
  } catch (e) {
    relatorio.confere(nome, false, e.message);
    return null;
  }
}

async function atende(relatorio, nome, promessa) {
  const ok = await promessa.then((r) => Boolean(r), () => false);
  relatorio.confere(nome, ok);
}

module.exports = {
  id: 'orcamento-estoura',
  letra: 'b',
  titulo: 'O orçamento de IA estoura',
  esperado: 'A 90%: modelo avançado recusado (429 AI_BUDGET_EXHAUSTED) e regra, cache e modelo pequeno atendem. A 100%: modelo pequeno, avançado e cache recusados e a regra segue. Agente crítico a 100%: só o avançado é recusado.',
  async executar({ F, tenantA, relatorio }) {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      const nc = await F.orcamentoProgramavel(tenantA, tx);
      await nc.consumirAte(181);
      await recusado(relatorio, 'a 90% o modelo avançado é recusado', nc.tentar('ADVANCED_MODEL'));
      for (const caminho of ['RULE', 'CACHE', 'SMALL_MODEL']) await atende(relatorio, `a 90% ${caminho} atende`, nc.tentar(caminho));
      await nc.consumirAte(200);
      for (const caminho of ['SMALL_MODEL', 'ADVANCED_MODEL', 'CACHE']) await recusado(relatorio, `a 100% ${caminho} é recusado`, nc.tentar(caminho));
      await atende(relatorio, 'a 100% a regra de custo zero segue', nc.tentar('RULE'));
      const critico = await F.orcamentoProgramavel(tenantA, tx);
      await critico.consumirAte(200);
      for (const caminho of ['RULE', 'CACHE', 'SMALL_MODEL']) await atende(relatorio, `crítico a 100%: ${caminho} atende`, critico.tentar(caminho, { criticality: 'CRITICAL' }));
      const err = await recusado(relatorio, 'crítico a 100%: o avançado é recusado', critico.tentar('ADVANCED_MODEL', { criticality: 'CRITICAL' }));
      relatorio.confere('o estado do orçamento é EXHAUSTED', Boolean(err) && err.details && err.details.state === 'EXHAUSTED');
    });
  },
};
