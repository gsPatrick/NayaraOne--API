'use strict';

/**
 * Registro de execução da NAY (M9-D005): ponto de entrada do orquestrador para gravar runs em ai.ai_runs e fontes em
 * ai.ai_sources. Abre (`startRun`, idempotente), fecha (`finishRun`, com custo exato e evento ai.run.completed/failed na
 * mesma transação), grava fontes (`recordSource`, trecho limitado por ia.fonte.excerpt_max_caracteres e já com redaction de
 * secret, via src/shared/redaction), lê com permissão (`getRun`) e registra as NAYs determinísticas (`recordRuleRun`).
 */
module.exports = require('./runs');
