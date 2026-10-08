'use strict';

const AppError = require('../../../utils/AppError');
const { resilientFetch } = require('../../../utils/resilientFetch');

// Interface comum (duck-typed, mesmo estilo de BankAdapter.js/SignatureAdapter.js):
//   async quote(req) -> { externalId, premiumAmount, coverageSummary, raw }
//   async issuePolicy(req) -> { externalId, policyNumber, status, raw }
//   async getPolicyStatus(externalId) -> { externalId, status, raw }
//   async submitClaim(req) -> { externalId, status, raw }
//   async getClaimStatus(externalId) -> { externalId, status, raw }
// "Adapter para cotação/proposta/apólice/status quando disponível." (contrato 00000009, Anexo I,
// "GUIA DO MARCELO — INTEGRAÇÕES, APIs E WEBHOOKS", seção 14 "Seguradoras/garantias")

class SandboxInsuranceAdapter {
  async quote(req) {
    return {
      externalId: `sandbox-quote-${Date.now()}`,
      premiumAmount: req.estimatedValue ? Number(req.estimatedValue) * 0.01 : 100,
      coverageSummary: 'Cotação simulada (sandbox) — sem envio real à seguradora.',
      raw: { sandbox: true, req },
    };
  }

  async issuePolicy(req) {
    return {
      externalId: `sandbox-policy-${req.idempotencyKey || Date.now()}`,
      policyNumber: `SANDBOX-${Date.now()}`,
      status: 'ACTIVE',
      raw: { sandbox: true, req },
    };
  }

  async getPolicyStatus(externalId) {
    return { externalId, status: 'ACTIVE', raw: { sandbox: true } };
  }

  async submitClaim(req) {
    return { externalId: `sandbox-claim-${req.idempotencyKey || Date.now()}`, status: 'UNDER_REVIEW', raw: { sandbox: true, req } };
  }

  async getClaimStatus(externalId) {
    // Mock determinístico: toda consulta em sandbox aprova — suficiente pra testar o fluxo
    // completo (submit -> status -> settle -> ledger) sem nenhuma rede real.
    return { externalId, status: 'SETTLED', settledAmount: null, raw: { sandbox: true } };
  }
}

// GAP REAL CORRIGIDO (auditoria "mais um ciclo de 5", 2026-10-08; INT-005 a INT-008 do contrato
// — timeout/retry classificado/circuit breaker): era `fetch` crua, sem bound de tempo, sem
// retry e sem circuit breaker — uma seguradora lenta/fora do ar travava a chamada indefinidamente
// e cada tentativa nova martelava a rede de novo, sem parar. Ver src/utils/resilientFetch.js.
async function httpRequestJson({ circuitKey, method, url, headers, body }) {
  const response = await resilientFetch({ circuitKey, method, url, headers, body });
  let parsed = null;
  const raw = await response.text();
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
  return { statusCode: response.status, body: parsed };
}

// ---------------------------------------------------------------------------------------------
// PORTO SEGURO — auth CONFIRMADA contra a documentação pública real (dev.portoseguro.com.br/
// api-portal/content/autorizacao, pesquisa out/2026): OAuth2 client_credentials, Basic auth
// (base64 de client_id:client_secret) no endpoint de token, Bearer token nas chamadas
// subsequentes, token válido 3600s. Essa parte está correta e verificada.
//
// O QUE NÃO ESTÁ CONFIRMADO: os paths exatos do produto "Fiança Locatícia Essencial" (cotação,
// emissão, sinistro) — a documentação técnica detalhada desses endpoints fica atrás de login no
// portal, e o próprio portal afirma hoje só aceitar cadastro de "parceiros previamente indicados
// pelas áreas de produto" (não é self-service puro como se pensava antes desta pesquisa). Os
// paths abaixo (`/fianca-locaticia/...`) são um palpite razoável baseado no nome do produto, NÃO
// uma confirmação — precisam ser corrigidos no primeiro teste real contra sandbox.
// ---------------------------------------------------------------------------------------------
class PortoSeguroInsuranceAdapter {
  constructor({ clientId, clientSecret, baseUrl, authBaseUrl }) {
    if (!clientId || !clientSecret) {
      throw AppError.internal('Configuração do provider Porto Seguro incompleta.', 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    // Confirmado: https://portoapi-hml.portoseguro.com.br (homologação) — produção não
    // confirmada publicamente, assumida por convenção de nome (sem "-hml").
    this.authBaseUrl = authBaseUrl || 'https://portoapi-hml.portoseguro.com.br';
    this.baseUrl = baseUrl || 'https://portoapi-hml.portoseguro.com.br';
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - 5000) return this._accessToken;
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const bodyStr = new URLSearchParams({ grant_type: 'client_credentials' }).toString();
    const { statusCode, body } = await httpRequestJson({
      circuitKey: 'insurance:portoseguro',
      method: 'POST',
      url: `${this.authBaseUrl}/oauth/v2/access-token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
      body: bodyStr,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw AppError.internal('Falha ao autenticar com o provider Porto Seguro.', 'PROCUREMENT_INSURANCE_PROVIDER_AUTH_ERROR', { status: statusCode, body });
    }
    this._accessToken = body.access_token;
    this._tokenExpiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return this._accessToken;
  }

  async _request(method, path, payload) {
    const token = await this._getAccessToken();
    const { statusCode, body } = await httpRequestJson({
      circuitKey: 'insurance:portoseguro',
      method,
      url: `${this.baseUrl}${path}`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw AppError.internal('Erro na chamada ao provider Porto Seguro.', 'PROCUREMENT_INSURANCE_PROVIDER_ERROR', { status: statusCode, body });
    }
    return body;
  }

  // NOTA: path não confirmado publicamente — ver comentário da classe.
  async quote(req) {
    const raw = await this._request('POST', '/fianca-locaticia/v1/cotacoes', req);
    return { externalId: raw?.id, premiumAmount: raw?.valorPremio, coverageSummary: raw?.coberturas, raw };
  }

  async issuePolicy(req) {
    const raw = await this._request('POST', '/fianca-locaticia/v1/apolices', req);
    return { externalId: raw?.id, policyNumber: raw?.numeroApolice, status: 'ISSUED', raw };
  }

  async getPolicyStatus(externalId) {
    const raw = await this._request('GET', `/fianca-locaticia/v1/apolices/${externalId}`);
    return { externalId, status: raw?.status, raw };
  }

  async submitClaim(req) {
    const raw = await this._request('POST', '/fianca-locaticia/v1/sinistros', req);
    return { externalId: raw?.id, status: 'UNDER_REVIEW', raw };
  }

  async getClaimStatus(externalId) {
    const raw = await this._request('GET', `/fianca-locaticia/v1/sinistros/${externalId}`);
    return { externalId, status: raw?.status, settledAmount: raw?.valorIndenizacao, raw };
  }
}

// ---------------------------------------------------------------------------------------------
// JUNTO SEGUROS — NENHUM detalhe técnico confirmado contra documentação pública (pesquisa
// out/2026). A Junto só libera o portal de desenvolvedor/documentação depois que a empresa vira
// corretora parceira (confirmado: "Para solicitar acesso à API da Junto Seguros, é necessário
// ser corretora parceira") — diferente de Porto Seguro/Yelum, não há NENHUM PDF técnico público
// nem portal de desenvolvedor acessível sem essa parceria prévia. O código abaixo é um
// ESQUELETO ESTRUTURAL seguindo o mesmo contrato das outras duas (Bearer token), mas os paths,
// nomes de campo e até o mecanismo de auth exato são DESCONHECIDOS — não confirme nada aqui como
// "pronto", isso só pode ser escrito de verdade depois que a Nayara formalizar a parceria e
// tiver acesso real à documentação.
// ---------------------------------------------------------------------------------------------
class JuntoSegurosInsuranceAdapter {
  constructor() {
    // Lança sempre — não existe nenhuma forma confirmada de configurar isso corretamente ainda.
    // resolveInsuranceAdapter.js nunca chega a instanciar esta classe (nenhuma credencial é
    // pedida nas settings), este throw é só uma segunda trava de segurança.
    throw AppError.internal(
      'Provider Junto Seguros ainda não tem documentação técnica pública acessível — requer parceria de corretora formalizada antes de qualquer integração real ser escrita.',
      'PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED'
    );
  }
}

// ---------------------------------------------------------------------------------------------
// YELUM SEGUROS — CONFIRMADO contra documentação técnica pública real e completa ("Detalhamento
// técnico das APIs — Guarantee Quote", encontrado em yelumseguros.com.br, pesquisa out/2026).
// A Yelum é o nome atual da Liberty Seguros Brasil (rebranding) — os hosts reais são do grupo
// HDI Seguros. Endpoints, payload e resposta abaixo batem com o PDF, campo a campo.
// ---------------------------------------------------------------------------------------------
class YelumInsuranceAdapter {
  constructor({ apiKey, baseUrl }) {
    if (!apiKey) {
      throw AppError.internal('Configuração do provider Yelum incompleta.', 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
    }
    this.apiKey = apiKey;
    // Confirmado no PDF: homologação "integracao-tst.grupohdiseguros.com.br", produção
    // "integracao.grupohdiseguros.com.br".
    this.baseUrl = baseUrl || 'https://integracao-tst.grupohdiseguros.com.br';
  }

  async _request(method, path, payload) {
    const { statusCode, body } = await httpRequestJson({
      circuitKey: 'insurance:yelum',
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    // Formato de erro confirmado no PDF: {"Success": false, "Data": null, "Messages": [{"Description": "..."}]}.
    if (statusCode < 200 || statusCode >= 300 || body?.Success === false) {
      const messages = Array.isArray(body?.Messages) ? body.Messages.map((m) => m.Description).join('; ') : null;
      throw AppError.internal(
        messages || 'Erro na chamada ao provider Yelum.',
        'PROCUREMENT_INSURANCE_PROVIDER_ERROR',
        { status: statusCode, body }
      );
    }
    return body;
  }

  // Confirmado: POST /cotador/fianca/v1/quote — campos obrigatórios mínimos (User, OfferLetter,
  // BrokerEmail, FollowUpEmail, Purpose, HirePlan, Commission, TenantData, Coverages) — demais
  // dados (CPF do locatário, endereço, renda etc.) vêm de `req`, montados pelo service layer a
  // partir do que a Nayara já tem cadastrado (Person/Property), não inventados aqui.
  async quote(req) {
    const raw = await this._request('POST', '/cotador/fianca/v1/quote', req);
    const data = raw?.Data;
    return {
      // QuoteNo é Integer na doc da Yelum — stringificado aqui pra bater com o contrato comum
      // do adapter (externalId sempre string) e com `issuePolicy` abaixo, que já fazia isso.
      externalId: data?.QuoteNo != null ? String(data.QuoteNo) : null,
      premiumAmount: data?.TotalPremium,
      coverageSummary: data?.Status,
      raw,
    };
  }

  // A Yelum não separa "emitir apólice" de "cotar" num endpoint distinto no documento
  // consultado — o PUT no mesmo path (/cotador/fianca/v1/quote, com QuoteNo preenchido) faz o
  // "recálculo"/atualização da cotação existente. Documentação consultada não cobre o passo de
  // emissão formal da apólice (só cotação/recotação) — issuePolicy usa o mesmo PUT como melhor
  // aproximação documentada; precisa confirmação quando houver acesso a credencial real.
  async issuePolicy(req) {
    const raw = await this._request('PUT', '/cotador/fianca/v1/quote', req);
    const data = raw?.Data;
    return {
      externalId: String(data?.QuoteNo),
      policyNumber: req?.PolicyNo ? String(req.PolicyNo) : null,
      status: data?.Status === 'Elabora Proposta' ? 'ISSUED' : 'QUOTED',
      raw,
    };
  }

  // Documento consultado não especifica um endpoint de consulta de status nem de sinistro —
  // só cobre "API de Cotação Fiança" (criação/atualização). Esses dois métodos ficam como
  // NÃO IMPLEMENTADOS explicitamente, em vez de inventar um path que não existe no documento.
  async getPolicyStatus() {
    throw AppError.internal(
      'Consulta de status de apólice não está documentada publicamente para a Yelum — só a API de cotação (criação/atualização) foi confirmada.',
      'PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async submitClaim() {
    throw AppError.internal(
      'Submissão de sinistro não está documentada publicamente para a Yelum — só a API de cotação (criação/atualização) foi confirmada.',
      'PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async getClaimStatus() {
    throw AppError.internal(
      'Consulta de status de sinistro não está documentada publicamente para a Yelum — só a API de cotação (criação/atualização) foi confirmada.',
      'PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED'
    );
  }
}

module.exports = {
  SandboxInsuranceAdapter,
  PortoSeguroInsuranceAdapter,
  JuntoSegurosInsuranceAdapter,
  YelumInsuranceAdapter,
};
