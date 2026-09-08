'use strict';

const { getDecryptedSetting } = require('../../settings/settings.service');

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

/**
 * IpcaIndexSourceAdapter — busca a variação mensal do IPCA (Índice Nacional de Preços ao
 * Consumidor Amplo) na API pública de agregados do IBGE (SIDRA). Só responde para
 * `indexCode === 'IPCA'` — qualquer outro código retorna indisponível (não é responsabilidade
 * deste adapter).
 *
 * Agregado 1737 ("IPCA - Variação mensal, acumulada no ano, acumulada 12 meses e peso mensal")
 * — variável 63 = "IPCA - Variação mensal (%)", nível territorial N1 (Brasil), código 1.
 *
 * QUALQUER falha (rede fora do ar, timeout, resposta não-2xx, JSON inesperado/vazio, valor
 * não numérico) faz este adapter retornar `{ available: false }` — NUNCA lança exceção,
 * NUNCA inventa um valor. `rentAdjustment.service.js` trata "indisponível" marcando o
 * reajuste como PENDING_SOURCE, sem gravar percentual algum.
 */
async function fetchIpcaFromIbge(period) {
  const [year, month] = period.split('-');
  const competencia = `${year}${month}`; // formato exigido pela API SIDRA: YYYYMM
  const url = `https://servicodados.ibge.gov.br/api/v3/agregados/1737/periodos/${competencia}/variaveis/63?localidades=N1[all]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { available: false };

    const json = await response.json();
    // Formato esperado: [{ id, variavel, unidade, resultados: [{ series: [{ serie: { "YYYYMM": "valor" } }] }] }]
    const resultados = json && json[0] && json[0].resultados;
    const serie = resultados && resultados[0] && resultados[0].series && resultados[0].series[0] && resultados[0].series[0].serie;
    const rawValue = serie ? serie[competencia] : undefined;

    if (rawValue === undefined || rawValue === null || rawValue === '...' || rawValue === '-') {
      return { available: false };
    }
    const numericValue = Number(String(rawValue).replace(',', '.'));
    if (Number.isNaN(numericValue)) return { available: false };

    return { available: true, rawValue: numericValue };
  } catch (err) {
    // Rede fora do ar, timeout, JSON malformado etc. — nunca propaga, sempre "indisponível".
    return { available: false };
  } finally {
    clearTimeout(timeout);
  }
}

const IpcaIndexSourceAdapter = {
  async getIndex(indexCode, period) {
    if (indexCode !== 'IPCA') return { available: false };
    if (!period || !/^\d{4}-\d{2}$/.test(period)) return { available: false };
    return fetchIpcaFromIbge(period);
  },
};

/**
 * FgvIgpmIndexSourceAdapter — fonte de índice para IGPM (Índice Geral de Preços do Mercado,
 * calculado pela FGV). O IGPM da FGV não tem uma API pública gratuita equivalente ao IBGE —
 * por isso este adapter só tenta rede quando o tenant EXPLICITAMENTE configurou modo
 * "automatic" com um token de API contratado (`billing.igpm_mode` + `billing.fgv_api_token`
 * em settings). Em modo "manual" (default) OU sem token configurado, retorna
 * `{ available: false }` SEM NUNCA tentar rede — importante para previsibilidade de testes e
 * para não vazar tentativas de chamada para um serviço pago sem token válido.
 *
 * DECISÃO DE ENGENHARIA — endpoint exato depende do plano contratado, confirmar com
 * documentação FGV Dados antes de produção: a FGV oferece o IGPM via produtos pagos
 * (FGV Dados/IBRE) cujo endpoint, formato de autenticação e payload de resposta variam por
 * contrato — não há uma URL pública fixa e gratuita para "confirmar contra documentação"
 * neste marco. A chamada HTTP está isolada em `_request` para troca fácil quando o
 * endpoint real do plano contratado for conhecido.
 */
class FgvIgpmIndexSourceAdapter {
  constructor({ getSettingFn, tenant, transaction } = {}) {
    this.getSettingFn = getSettingFn;
    this.tenant = tenant;
    this.transaction = transaction;
  }

  async _request(apiToken, period) {
    const url = `https://api.fgvdados.fgv.br/v1/indicadores/igpm/${period}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!response.ok) return { available: false };
    const json = await response.json();
    const rawValue = json && (json.valor ?? json.value);
    const numericValue = Number(rawValue);
    if (Number.isNaN(numericValue)) return { available: false };
    return { available: true, rawValue: numericValue };
  }

  async getIndex(indexCode, period) {
    if (indexCode !== 'IGPM') return { available: false };
    if (!this.getSettingFn || !this.tenant) return { available: false };

    try {
      const mode = await this.getSettingFn('billing.igpm_mode', this.tenant, this.transaction, 'manual');
      if (mode !== 'automatic') return { available: false }; // modo manual: nunca tenta rede.

      const apiToken = await getDecryptedSetting('billing.fgv_api_token', this.tenant, this.transaction, null);
      if (!apiToken) return { available: false }; // sem token: nunca tenta rede.

      return await this._request(apiToken, period);
    } catch (err) {
      return { available: false };
    }
  }
}

module.exports = {
  unavailableIndexSourceAdapter,
  createMockIndexSourceAdapter,
  IpcaIndexSourceAdapter,
  FgvIgpmIndexSourceAdapter,
};
