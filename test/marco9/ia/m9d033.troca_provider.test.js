'use strict';

// M9-D033 — troca de provider: o golden roda com sandbox-a e sandbox-b (respostas distintas, porém válidas) e continua verde;
// queda em uma categoria bloqueia a troca; quem altera o golden não homologa a versão. nayara_runtime (RLS real), com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const G = require('../_helpers/iaGolden');
const { resolveEvalProvider, registerEvalProvider } = require('../../../src/features/ai/evaluations/evalProviders');
const { sandboxGenerate } = require('../../../src/features/ai/providers/sandbox/sandboxGenerate');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenantA;
let pessoas;
before(async () => {
  ({ tenantA } = await G.prepararTenants());
  await G.carregarPessoas();
  pessoas = [G.ctxDe(tenantA), G.ctxDe(tenantA), G.ctxDe(tenantA), G.ctxDe(tenantA)].map((c) => c.userId);
});
after(async () => { await G.sequelize.close(); });

const AVAL = 'ai:evaluate';
const CATEGORIAS = ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY'];

/** Roda o golden do agente com o provider e devolve o resultado por categoria. */
async function golden(tx, disparador, code, providerCode) {
  const ev = await G.avaliar(G.svc, G.como(tenantA, disparador, AVAL), tx, { agentCode: code, suite: 'golden', providerCode });
  return ev;
}

async function adv_troca_de_provider_golden_continua_verde(tx) {
  const [criador, disparador] = pessoas;
  const { code } = await G.criarAgente(tenantA, tx, criador);
  await G.cadastrarSeis(G.como(tenantA, criador), code, tx);
  const resultados = {};
  for (const provider of ['sandbox-a', 'sandbox-b']) {
    const ev = await golden(tx, disparador, code, provider);
    assert.equal(ev.status, 'PASSED', `${provider}: ${JSON.stringify(ev.metrics)}`);
    assert.equal(ev.providerCode, provider);
    for (const c of CATEGORIAS) {
      assert.equal(ev.metrics[c].ok, true, `${provider} ${c}`);
      if (ev.metrics[c].pct !== undefined) assert.equal(ev.metrics[c].pct, '100.00', `${provider} ${c} precisa de 100%`);
    }
    resultados[provider] = ev;
  }
  return { code, resultados };
}

test('adv_troca_de_provider_golden_continua_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { resultados } = await adv_troca_de_provider_golden_continua_verde(tx);
    // Os dois perfis respondem de forma distinta (modelo, custo e latência), porém válida.
    assert.notEqual(resultados['sandbox-a'].modelCode, resultados['sandbox-b'].modelCode);
    assert.notEqual(resultados['sandbox-a'].metrics.COST.avgMicros, resultados['sandbox-b'].metrics.COST.avgMicros);
    const entrada = { system: '', messages: [{ role: 'user', content: '[[ECO]] O saldo devedor é R$ 18.432,50 [1].' }] };
    const a = resolveEvalProvider('sandbox-a')(entrada);
    const b = resolveEvalProvider('sandbox-b')(entrada);
    assert.notEqual(a.text, b.text);
    assert.ok(a.text.includes('18.432,50') && b.text.includes('18.432,50'));
    assert.deepEqual(sandboxGenerate(entrada).text, a.text, 'sandbox-a mantém a resposta do sandbox padrão');
  });
});

test('m9d033_provider_swap_passa_golden_tests', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const { code } = await adv_troca_de_provider_golden_continua_verde(tx);
    // Com a regressão verde nos dois perfis a troca do provedor do agente é liberada.
    await G.avaliar(G.svc, G.como(tenantA, disparador, AVAL), tx, { agentCode: code, suite: 'adversarial', providerCode: 'sandbox-b' });
    const v1 = await G.agents.getVersion(G.como(tenantA, criador), code, 1, tx);
    const trocado = await G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { ...v1.modelPolicy, provider: 'sandbox-b', model: 'sandbox-b-1' } }, tx);
    assert.equal(trocado.modelPolicy.provider, 'sandbox-b');
    // O perfil não é provider real: não exige o parâmetro de provider real.
    const ev = await golden(tx, disparador, code, 'sandbox-b');
    assert.equal(ev.status, 'PASSED');
  });
});

test('m9d033_queda_em_uma_categoria_bloqueia_a_troca', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await G.cadastrarSeis(G.como(tenantA, criador), code, tx);
    // O provider "ruim" erra uma categoria (cita número fora das fontes): a avaliação reprova e a troca continua barrada.
    registerEvalProvider('sandbox-ruim', (input) => ({ ...sandboxGenerate(input), text: 'O saldo devedor é R$ 1,00.' }));
    const ev = await golden(tx, disparador, code, 'sandbox-ruim').catch((e) => e);
    if (ev instanceof Error) {
      assert.equal(ev.code, 'AI_REAL_PROVIDER_EVAL_DISABLED');
      await upsertSetting('ia.avaliacao.permitir_provider_real', true, G.como(tenantA, criador), criador, tx);
    }
    const ruim = ev instanceof Error ? await golden(tx, disparador, code, 'sandbox-ruim') : ev;
    assert.equal(ruim.status, 'FAILED');
    await G.rejeita(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { provider: 'sandbox-ruim' } }, tx), 409, 'AI_REGRESSION_REQUIRED');
  });
});

test('m9d033_quem_altera_o_golden_nao_homologa_a_versao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [autor, disparador, outra, criador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await G.cadastrarSeis(G.como(tenantA, autor), code, tx);
    const ev = await golden(tx, disparador, code, 'ai-sandbox');
    assert.equal(ev.status, 'PASSED');
    await G.avaliar(G.svc, G.como(tenantA, disparador, AVAL), tx, { agentCode: code, suite: 'adversarial' });
    // quem criou os casos do golden não homologa a versão; outra pessoa homologa
    await G.rejeita(G.agents.homologate(G.como(tenantA, autor), code, 1, {}, tx), 403, 'AI_AGENT_SEGREGATION');
    assert.equal((await G.agents.homologate(G.como(tenantA, outra), code, 1, {}, tx)).status, 'HOMOLOGATED');
  });
});
