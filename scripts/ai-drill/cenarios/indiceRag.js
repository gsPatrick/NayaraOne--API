'use strict';

/**
 * Drill (c) do livro: o índice do RAG está corrompido ou indisponível. A NAY responde a frase de insuficiência de fontes e nunca inventa o valor
 * que o modelo (falso) tenta afirmar. Duas falhas: o índice sem nenhum trecho ativo (corrompido) e a busca que falha (indisponível).
 */
const FRASE = 'Não tenho informações suficientes nas fontes autorizadas para responder isso com segurança.';
const PERGUNTA = 'qual a multa do contrato de rescisão Zeta? [[RESPOSTA:A multa do contrato Zeta é de R$ 1.500,00 [1].]]';

module.exports = {
  id: 'indice-rag-indisponivel',
  letra: 'c',
  titulo: 'O índice do RAG está corrompido ou indisponível',
  esperado: 'A NAY responde a frase de insuficiência de fontes, sem fonte e sem o valor que o modelo inventou; o run termina sem erro técnico exposto.',
  async executar({ F, tenantA, relatorio }) {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      // 1) Índice corrompido: o documento foi indexado e depois o índice ficou sem trecho ativo.
      const c = await F.cenarioRag(tenantA, tx);
      await F.documento(tenantA, tx, F.DOCUMENTOS.limpo);
      await F.sequelize.query("UPDATE ai.chunks SET status = 'REVOKED' WHERE company_id = :c", { replacements: { c: tenantA.companyId }, transaction: tx }); // o índice não apaga trecho: sem trecho ativo ele é inútil
      const sem = await F.H.rodar(c, PERGUNTA);
      relatorio.confere('índice vazio: o run termina', sem.ok === true, JSON.stringify(sem.error || null));
      relatorio.confere('índice vazio: status INSUFFICIENT_SOURCES', sem.groundingStatus === 'INSUFFICIENT_SOURCES', sem.groundingStatus);
      relatorio.confere('índice vazio: resposta é a frase de insuficiência', String(sem.answer).startsWith(FRASE), sem.answer);
      relatorio.confere('índice vazio: o valor inventado não aparece', !/1\.500/.test(String(sem.answer)));
      relatorio.confere('índice vazio: nenhuma fonte citada', (sem.sources || []).length === 0);
      // 2) Índice indisponível: a busca falha (erro de conexão com o índice).
      const falha = await F.cenarioRag(tenantA, tx, { deps: { retrieve: async () => { throw new Error('índice de busca indisponível'); } } });
      const indisp = await F.H.rodar(falha, PERGUNTA);
      relatorio.confere('índice indisponível: o run termina', indisp.ok === true, JSON.stringify(indisp.error || null));
      relatorio.confere('índice indisponível: responde insuficiência', String(indisp.answer).startsWith(FRASE), indisp.answer);
      relatorio.confere('índice indisponível: o valor inventado não aparece', !/1\.500/.test(String(indisp.answer)));
      relatorio.confere('índice indisponível: o erro técnico não vaza', !/indispon[ií]vel/i.test(String(indisp.answer).replace(FRASE, '')), indisp.answer);
    });
  },
};
