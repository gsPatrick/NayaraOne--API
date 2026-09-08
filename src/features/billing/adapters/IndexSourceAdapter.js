'use strict';

/**
 * IndexSourceAdapter — interface simples para consultar o valor bruto de um índice de reajuste
 * (ex.: IGPM, IPCA) em uma competência (period, "YYYY-MM").
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno não define QUAL fonte real de
 * índice usar (FGV/IBGE/API paga de terceiro), então não implementamos nenhuma chamada de rede
 * real aqui. O adapter default (`unavailableIndexSourceAdapter`) sempre responde "indisponível"
 * — rentAdjustment.service.js trata isso marcando o reajuste como PENDING_SOURCE e NUNCA grava
 * um percentual inventado. Um adapter real (ex.: `Http IGPM/IPCA Adapter`) pode ser plugado
 * depois implementando a mesma interface `{ getIndex(indexCode, period) }` e passado via
 * injeção no service (parâmetro opcional), sem mudar a regra de negócio.
 */
async function getIndex(_indexCode, _period) {
  return { available: false };
}

const unavailableIndexSourceAdapter = { getIndex };

/**
 * createMockIndexSourceAdapter — helper de teste/homologação: permite simular uma fonte de
 * índice disponível sem depender de rede real. Usado apenas por testes
 * (test/billing.rentAdjustment.test.js) — nunca deve ser o adapter default em runtime.
 */
function createMockIndexSourceAdapter(fixedValuesByKey) {
  return {
    async getIndex(indexCode, period) {
      const key = `${indexCode}:${period}`;
      if (Object.prototype.hasOwnProperty.call(fixedValuesByKey, key)) {
        return { available: true, rawValue: fixedValuesByKey[key] };
      }
      return { available: false };
    },
  };
}

module.exports = { unavailableIndexSourceAdapter, createMockIndexSourceAdapter };
