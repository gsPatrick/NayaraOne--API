'use strict';

/**
 * Drill (e) do livro: o secret do provedor expirou ou foi revogado. O adapter real falha fechado: com o secret ausente no cofre (400, não chama o fornecedor);
 * com o secret recusado pelo fornecedor (401: AI_PROVIDER_AUTH, sem reenvio). A credencial nunca aparece no erro, e a NAY não cai para o provedor de testes.
 */
const util = require('node:util');
const { startProviderServer } = require('../../../test/marco9/_helpers/iaProviderServer');
const { realCtx, SEGREDO } = require('../../../test/marco9/_helpers/iaAdapterCtx');
const { pedido } = require('../../../test/marco9/_helpers/iaAdapterContract');
const { OpenAIAdapter } = require('../../../src/features/ai/providers/openai/OpenAIAdapter');
const { AnthropicAdapter } = require('../../../src/features/ai/providers/anthropic/AnthropicAdapter');

const chamar = (adapter, texto) => adapter.generate(pedido('m-gen', texto)).then(() => null, (e) => e);
const visivel = (e, adapter) => [e.message, JSON.stringify(e), util.inspect(e, { depth: 6 }), e.stack, util.inspect(adapter, { depth: 6 })].join('\n');

module.exports = {
  id: 'secret-revogado',
  letra: 'e',
  titulo: 'O secret do provedor expirou ou foi revogado',
  esperado: 'O adapter falha fechado: kind AUTH, sem reenvio, sem chamar o fornecedor quando o cofre não tem o secret, sem a credencial em lugar nenhum e sem trocar de provedor.',
  async executar({ relatorio }) {
    const srv = await startProviderServer();
    try {
      for (const [Classe, codigo, caminho] of [[OpenAIAdapter, 'openai', '/v1/chat/completions'], [AnthropicAdapter, 'anthropic', '/v1/messages']]) {
        const revogado = new Classe(realCtx(codigo, srv.baseUrl, { secret: null }));
        const antes = srv.hits[caminho] || 0;
        const e1 = await chamar(revogado, 'Olá');
        relatorio.confere(`${codigo}: secret ausente no cofre falha fechada (AUTH)`, Boolean(e1) && e1.kind === 'AUTH' && e1.retryable === false, e1 && e1.kind);
        relatorio.confere(`${codigo}: o fornecedor não é chamado sem credencial`, (srv.hits[caminho] || 0) === antes);
        const expirado = new Classe(realCtx(codigo, srv.baseUrl));
        const antes2 = srv.hits[caminho] || 0;
        const e2 = await chamar(expirado, '[[ECHO_KEY]]');
        relatorio.confere(`${codigo}: secret recusado pelo fornecedor vira AI_PROVIDER_AUTH`, Boolean(e2) && e2.kind === 'AUTH' && e2.code === 'AI_PROVIDER_AUTH', e2 && e2.code);
        relatorio.confere(`${codigo}: AUTH não é reenviado (uma chamada só)`, (srv.hits[caminho] || 0) - antes2 === 1, String((srv.hits[caminho] || 0) - antes2));
        relatorio.confere(`${codigo}: a credencial não vaza em erro, log nem objeto`, !visivel(e2, expirado).includes(SEGREDO) && !visivel(e1, revogado).includes(SEGREDO));
        relatorio.confere(`${codigo}: o texto do fornecedor não passa`, !visivel(e2, expirado).includes('invalid api key'));
      }
    } finally {
      await srv.close();
    }
  },
};
