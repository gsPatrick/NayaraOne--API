'use strict';

const AppError = require('../../../../utils/AppError');
const { IntegrationHttpClient } = require('../../../../features/integrations/http/IntegrationHttpClient');
const { hostOf } = require('../../../../features/integrations/http/egressPolicy');
const { fetchExternalUrl } = require('../../../../features/integrations/http/ssrfGuard');
const { generateContractPdf } = require('../../contracts/application/contractPdf.service');

// M9-D209: toda chamada HTTP de adapter passa pelo IntegrationHttpClient.
const httpClient = new IntegrationHttpClient({ providerCode: 'signature' });
const { loadSignerContacts } = require('./signer-contacts');

/**
 * ZapSignSignatureAdapter — integração real com a API do ZapSign.
 *
 * DECISÃO DE ENGENHARIA — não testado contra credencial real: URL/payload baseado no
 * conhecimento geral da API pública do ZapSign, confirmar contra documentação oficial
 * atualizada antes de produção. Em especial: (1) a criação de documento normalmente espera um
 * PDF em base64 ou uma URL pública de arquivo — usar apenas o hash de conteúdo da versão do
 * contrato é uma simplificação deste marco (sem acesso ao binário do documento neste ponto do
 * fluxo); (2) os nomes exatos dos campos de signatário (`signers`, `email`, `auth_mode` etc.)
 * podem ter mudado; (3) o formato do token de autenticação (Bearer vs. header próprio) deve
 * ser conferido. Toda a chamada HTTP é centralizada em `_request`.
 */
class ZapSignSignatureAdapter {
  constructor({ apiToken, baseUrl = 'https://api.zapsign.com.br/api/v1' } = {}) {
    if (!apiToken) {
      throw AppError.internal('ZapSignSignatureAdapter requer apiToken configurado.', 'LEGAL_SIGNATURE_PROVIDER_CONFIG_MISSING');
    }
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
    this._http = httpClient.scoped([hostOf(baseUrl)]); // M9-D244: só o host da URL base configurada
  }

  async _request(method, path, body) {
    const response = await this._http.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      json = null;
    }
    if (!response.ok) {
      throw AppError.internal(
        `ZapSign respondeu ${response.status} ao chamar ${method} ${path}.`,
        'LEGAL_SIGNATURE_PROVIDER_ERROR',
        { status: response.status, body: json }
      );
    }
    return json;
  }

  async requestSignature(contractVersion, signerPersonIds, transaction) {
    const signers = await loadSignerContacts(signerPersonIds, transaction);

    // CORRIGIDO (22/09/2026), mesma correção aplicada ao ClicksignSignatureAdapter: agora que
    // `ContractVersion.content` é persistido (migration 20260101000179) e
    // `contractPdf.service.js#generateContractPdf` reconstrói o PDF real em memória a partir
    // dele, subimos o binário de verdade em `base64_pdf` em vez de só um `external_id`
    // textual a partir do hash. DECISÃO DE ENGENHARIA ainda válida (não testado contra
    // credencial real): nome exato do campo (`base64_pdf`) deve ser confirmado contra a
    // documentação/conta real do ZapSign antes de produção.
    const { buffer: pdfBuffer } = await generateContractPdf(contractVersion.id, null, transaction);
    const doc = await this._request('POST', '/docs/', {
      name: `Contrato ${contractVersion.contractId} v${contractVersion.versionNumber}`,
      external_id: contractVersion.contentHash || contractVersion.id,
      base64_pdf: pdfBuffer.toString('base64'),
      signers: signers.map((signer) => ({ name: signer.name, email: signer.email })),
    });
    const providerEnvelopeId = doc && doc.token;

    const externalSignatureIdsByPerson = {};
    const returnedSigners = (doc && doc.signers) || [];
    signers.forEach((signer, index) => {
      const matched = returnedSigners[index] || {};
      externalSignatureIdsByPerson[signer.personId] = matched.token || `${providerEnvelopeId}-${index}`;
    });

    return { providerEnvelopeId, externalSignatureIdsByPerson };
  }

  /**
   * getStatus — consulta o status atual do documento no ZapSign.
   * DECISÃO DE ENGENHARIA — não testado contra credencial real: campo exato de status
   * (`status`) e seus valores possíveis (ex.: "pending", "signed", "refused") devem ser
   * confirmados contra a documentação/conta real antes de produção.
   */
  async getStatus(providerEnvelopeId) {
    const doc = await this._request('GET', `/docs/${providerEnvelopeId}/`);
    return { providerEnvelopeId, status: (doc && doc.status) || 'UNKNOWN', raw: doc };
  }

  /**
   * cancel — cancela o documento no ZapSign.
   * DECISÃO DE ENGENHARIA — não testado contra credencial real: o endpoint de cancelamento do
   * ZapSign (`/docs/{token}/delete/` ou similar) e o método HTTP exato devem ser confirmados
   * contra a documentação/conta real antes de produção.
   */
  async cancel(providerEnvelopeId) {
    const result = await this._request('POST', `/docs/${providerEnvelopeId}/delete/`);
    return { providerEnvelopeId, cancelled: true, raw: result };
  }

  /**
   * downloadSignedDocument — baixa o PDF assinado do ZapSign.
   * DECISÃO DE ENGENHARIA — não testado contra credencial real (este tenant não tem token
   * ZapSign configurado nesta sessão, só Clicksign): campo exato de URL de download
   * (`signed_file_url` assumido, baseado no padrão comum de resposta de `GET /docs/{token}/`)
   * deve ser confirmado contra a documentação/conta real antes de produção.
   */
  async downloadSignedDocument(providerEnvelopeId) {
    const doc = await this._request('GET', `/docs/${providerEnvelopeId}/`);
    const downloadUrl = doc && doc.signed_file_url;
    if (!downloadUrl) return null;

    // M9-D245: o link veio na resposta do fornecedor (terceiro): a busca passa pelo guarda SSRF e o conteúdo vem da quarentena.
    const baixado = await fetchExternalUrl(downloadUrl, { flow: 'signature_download' });
    return { buffer: baixado.buffer, fileName: (doc && doc.filename) || null, quarantine: baixado.quarantine };
  }
}

module.exports = { ZapSignSignatureAdapter };
