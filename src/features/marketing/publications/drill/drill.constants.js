'use strict';

const { mktError } = require('../../marketing.errors');

/**
 * M9-D442 — os 12 cenários do failure drill (tabela da seção 3 da demanda) e o resultado que o livro espera de cada um. Os 9 primeiros usam o cenário do sandbox da M9-D430
 * (mesmos nomes); os 3 últimos são do recebimento (webhook) e da entrega. O texto "esperado" vai para o relatório ao lado do que foi obtido.
 */
const DRILL_SCENARIOS = Object.freeze([
  { id: 'TIMEOUT', sandbox: 'TIMEOUT', expected: 'Job UNKNOWN; a reconciliação consulta o canal pela chave; nenhuma duplicidade.' },
  { id: 'UNKNOWN_BUT_PUBLISHED', sandbox: 'UNKNOWN_BUT_PUBLISHED', expected: 'A reconciliação marca PUBLISHED sem segundo post.' },
  { id: 'UNKNOWN_NOT_PUBLISHED', sandbox: 'UNKNOWN_NOT_PUBLISHED', expected: 'A reconciliação confirma a ausência e reenvia uma vez.' },
  { id: 'HTTP_429', sandbox: 'HTTP_429', expected: 'Respeita o Retry-After e o backoff; sem rajada.' },
  { id: 'HTTP_5XX', sandbox: 'HTTP_5XX', expected: 'O circuit breaker abre; os novos envios ficam PENDING sem perda; a meia-abertura testa uma chamada.' },
  { id: 'AUTH_REVOKED', sandbox: 'AUTH_REVOKED', expected: 'Conexão da família bloqueada até nova credencial, canal travado, alerta e nenhuma nova tentativa.' },
  { id: 'REJECTED', sandbox: 'REJECTED', expected: 'Job FAILED com motivo em português e sem nova tentativa.' },
  { id: 'DUPLICATE_KEY', sandbox: 'DUPLICATE_KEY', expected: 'Devolve a mesma resposta; sem duplicidade.' },
  { id: 'SLOW', sandbox: 'SLOW', expected: 'Acima do tempo máximo vale como TIMEOUT.' },
  { id: 'WEBHOOK_ASSINATURA_INVALIDA', sandbox: null, expected: '401 MKT_WEBHOOK_SIGNATURE_INVALID e nenhum efeito.' },
  { id: 'WEBHOOK_DUPLICADO', sandbox: null, expected: 'Processado uma vez.' },
  { id: 'FALHA_DE_ENTREGA', sandbox: null, expected: 'O CRM fica sem contato falso.' },
]);

/** Os cenários do sandbox (M9-D430, SCENARIOS) que o ensaio exercitou ao aprovar os cenários acima; OK é o caso de base que todo ensaio roda antes dos demais. */
const BASELINE_SCENARIO = 'OK';

const drillFailed = (details) => mktError(422, 'MKT_DRILL_FAILED', 'O failure drill encontrou comportamento inesperado no canal.', details);

/** Código de saída do script: 0 = tudo aprovado; 1 = divergência; 2 = uso incorreto ou banco não permitido. */
const EXIT = Object.freeze({ OK: 0, DIVERGENCE: 1, USAGE: 2 });

module.exports = { DRILL_SCENARIOS, BASELINE_SCENARIO, EXIT, drillFailed };
