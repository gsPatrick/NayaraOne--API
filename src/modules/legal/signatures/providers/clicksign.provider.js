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
 * ClicksignSignatureAdapter — integração real com a API v3 (REST) do Clicksign.
 *
 * Verificado contra a documentação oficial (developers.clicksign.com) em 18/09/2026:
 * - Base URL: sandbox `https://sandbox.clicksign.com/api/v3`, produção `https://app.clicksign.com/api/v3`.
 * - Autenticação: header `Authorization` com o access_token cru (SEM prefixo "Bearer").
 * - Formato JSON:API em todo o corpo (`Content-Type`/`Accept: application/vnd.api+json`).
 * - Fluxo de criação: POST /envelopes -> POST /envelopes/{id}/documents (upload base64) ->
 *   POST /envelopes/{id}/signers (um por signatário) -> POST /envelopes/{id}/requirements
 *   (qualificação "agree"/role "sign" + autenticação "provide_evidence"/auth "email", um par
 *   por signatário+documento) -> PATCH /envelopes/{id} (status "running") para ativar e
 *   disparar o envio de fato.
 * - O documento enviado é o PDF REAL do contrato (gerado sob demanda via
 *   `contractPdf.service.js#generateContractPdf`, mesma identidade visual usada no endpoint
 *   manual de geração de PDF), não mais um `.txt` de referência (ver histórico abaixo).
 */
class ClicksignSignatureAdapter {
  constructor({ apiToken, baseUrl = 'https://app.clicksign.com/api/v3' } = {}) {
    if (!apiToken) {
      throw AppError.internal('ClicksignSignatureAdapter requer apiToken configurado.', 'LEGAL_SIGNATURE_PROVIDER_CONFIG_MISSING');
    }
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
    this._http = httpClient.scoped([hostOf(baseUrl)]); // M9-D244: só o host da URL base configurada
  }

  // Centraliza a chamada HTTP — isola a camada de transporte para facilitar ajuste futuro
  // (retry, logging, mudança de endpoint) sem tocar na lógica de negócio do adapter.
  async _request(method, path, body) {
    const response = await this._http.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: this.apiToken,
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
        `Clicksign respondeu ${response.status} ao chamar ${method} ${path}.`,
        'LEGAL_SIGNATURE_PROVIDER_ERROR',
        { status: response.status, body: json }
      );
    }
    return json;
  }

  async requestSignature(contractVersion, signerPersonIds, transaction) {
    const signers = await loadSignerContacts(signerPersonIds, transaction);

    // 1) Envelope — `deadline_at` fica em aberto (sem prazo) neste marco.
    const envelope = await this._request('POST', '/envelopes', {
      data: {
        type: 'envelopes',
        attributes: {
          name: `Contrato ${contractVersion.contractId} v${contractVersion.versionNumber}`,
          locale: 'pt-BR',
          auto_close: true,
          remind_interval: 3,
        },
      },
    });
    const providerEnvelopeId = envelope && envelope.data && envelope.data.id;

    // 2) Documento — CORRIGIDO (22/09/2026): até aqui subíamos um `.txt` de referência porque
    // `ContractVersion` nunca guardava o texto de verdade (só `contentHash`), então não havia
    // nenhum binário real pra recuperar neste ponto do fluxo. Agora `ContractVersion.content`
    // é persistido (ver migration 20260101000179) e `contractPdf.service.js#generateContractPdf`
    // reconstrói o PDF a partir dele, EM MEMÓRIA, sob demanda — sem storage de disco envolvido
    // (contrato é conteúdo textual determinístico: mesmo `content` -> mesmo PDF). Subimos ESSE
    // binário real pro Clicksign. Gera de novo a cada chamada (em vez de cachear) de propósito:
    // garante que o documento enviado pra assinatura reflete o `content`/`contentHash` atuais
    // da ContractVersion no momento exato da solicitação.
    const { buffer: pdfBuffer } = await generateContractPdf(contractVersion.id, null, transaction);
    const contentBase64 = pdfBuffer.toString('base64');
    const documentResponse = await this._request('POST', `/envelopes/${providerEnvelopeId}/documents`, {
      data: {
        type: 'documents',
        attributes: {
          filename: `contrato-${contractVersion.contractId}-v${contractVersion.versionNumber}.pdf`,
          content_base64: `data:application/pdf;base64,${contentBase64}`,
          metadata: { contentHash: contractVersion.contentHash || null, contractVersionId: contractVersion.id },
        },
      },
    });
    const documentId = documentResponse && documentResponse.data && documentResponse.data.id;

    // 3) Signatários + requisitos (qualificação de assinatura + autenticação por e-mail).
    const externalSignatureIdsByPerson = {};
    for (const signer of signers) {
      const signerResponse = await this._request('POST', `/envelopes/${providerEnvelopeId}/signers`, {
        data: {
          type: 'signers',
          attributes: {
            name: signer.name,
            email: signer.email,
            has_documentation: false,
            communicate_events: { signature_request: 'email', signature_reminder: 'email', document_signed: 'email' },
          },
        },
      });
      const signerId = signerResponse && signerResponse.data && signerResponse.data.id;
      externalSignatureIdsByPerson[signer.personId] = signerId;

      await this._request('POST', `/envelopes/${providerEnvelopeId}/requirements`, {
        data: {
          type: 'requirements',
          attributes: { action: 'agree', role: 'sign' },
          relationships: {
            document: { data: { type: 'documents', id: documentId } },
            signer: { data: { type: 'signers', id: signerId } },
          },
        },
      });
      await this._request('POST', `/envelopes/${providerEnvelopeId}/requirements`, {
        data: {
          type: 'requirements',
          attributes: { action: 'provide_evidence', auth: 'email' },
          relationships: {
            document: { data: { type: 'documents', id: documentId } },
            signer: { data: { type: 'signers', id: signerId } },
          },
        },
      });
    }

    // 4) Ativa o envelope.
    await this._request('PATCH', `/envelopes/${providerEnvelopeId}`, {
      data: { id: providerEnvelopeId, type: 'envelopes', attributes: { status: 'running' } },
    });

    // 5) Dispara o convite de assinatura — CONFIRMADO contra a conta real (19/09/2026): ativar
    // o envelope (passo 4) NÃO manda o e-mail sozinho nesta conta, apesar do que a documentação
    // insinua ("para que as notificações sejam enviadas, você precisa ativá-lo"). O painel do
    // Clicksign mostrava "Nenhum e-mail enviado" mesmo com o envelope "running" há minutos —
    // só depois de chamar POST /envelopes/{id}/notifications o e-mail foi de fato disparado
    // (confirmado via `summary: [{ signer_id, notified: true }]` na resposta). Esse endpoint
    // tem rate limit agressivo (1 chamada/minuto) — uma falha aqui não deve derrubar
    // `initiateSignature` (a Signature já foi criada com sucesso do lado do Clicksign; o
    // signatário sempre pode ser renotificado depois via `checkSignatureStatus`/painel), por
    // isso é best-effort (log, não throw).
    try {
      await this._request('POST', `/envelopes/${providerEnvelopeId}/notifications`, {
        data: { type: 'notifications', attributes: {} },
      });
    } catch (err) {
      // best-effort — não interrompe o fluxo de negócio por causa disso.
    }

    return { providerEnvelopeId, externalSignatureIdsByPerson };
  }

  /**
   * getStatus — consulta o status atual do envelope no Clicksign.
   * Valores documentados: "draft", "running", "closed", "canceled".
   */
  async getStatus(providerEnvelopeId) {
    const envelope = await this._request('GET', `/envelopes/${providerEnvelopeId}`);
    const rawStatus = envelope && envelope.data && envelope.data.attributes && envelope.data.attributes.status;
    return { providerEnvelopeId, status: rawStatus || 'UNKNOWN', raw: envelope };
  }

  /**
   * cancel — CONFIRMADO contra a conta real (19/09/2026): o envelope em si só aceita PATCH
   * status "draft"/"running" — "canceled" no nível do envelope dá 400 ("status deve estar em:
   * draft, running"). O cancelamento de verdade é por DOCUMENTO (PATCH
   * /envelopes/{id}/documents/{document_id} status=canceled), e só funciona em documento
   * "running" (documento em draft, nunca ativado, dá 422 "documento não pode ser cancelado").
   * Por isso lista os documentos do envelope primeiro e cancela cada um.
   */
  async cancel(providerEnvelopeId) {
    const documentsResponse = await this._request('GET', `/envelopes/${providerEnvelopeId}/documents`);
    const documents = (documentsResponse && documentsResponse.data) || [];
    const results = [];
    for (const document of documents) {
      const result = await this._request('PATCH', `/envelopes/${providerEnvelopeId}/documents/${document.id}`, {
        data: { type: 'documents', id: document.id, attributes: { status: 'canceled' } },
      });
      results.push(result);
    }
    return { providerEnvelopeId, cancelled: true, raw: results };
  }

  /**
   * downloadSignedDocument — baixa o binário do documento assinado quando o envelope já
   * fechou. CONFIRMADO POR LEITURA DE DOCUMENTAÇÃO (developers.clicksign.com/reference/
   * api-listar-documentos, consultado 23/09/2026), NÃO testado ao vivo contra um envelope
   * realmente fechado nesta sessão (completar um ciclo de assinatura real exige interação
   * humana de terceiro — clique no link de assinatura recebido por e-mail — fora do nosso
   * controle automatizável): a resposta de `GET /envelopes/{id}/documents` traz, por
   * documento, `links.files.original` — uma URL presignada (S3) de download direto do
   * arquivo. Pelo funcionamento padrão de provedores de assinatura eletrônica (o Clicksign
   * carimba a evidência de assinatura DENTRO do mesmo PDF, não gera um arquivo separado),
   * essa é a mesma URL que passa a servir o PDF já assinado/carimbado depois que o documento
   * fecha — mas isso é uma inferência de comportamento típico do setor, não uma confirmação
   * byte-a-byte feita nesta sessão. Se a conta em produção se comportar diferente (endpoint de
   * export dedicado, ex. `/envelopes/{id}/documents/{id}/download`), este método precisa ser
   * ajustado — o primeiro sintoma seria `downloadSignedDocument` retornando um PDF idêntico ao
   * não-assinado (sem marca de assinatura visível).
   *
   * Retorna `null` (não lança) se o envelope não tiver nenhum documento — deixa o chamador
   * (handleEnvelopeClosedWebhook) decidir como tratar "nada pra baixar" sem derrubar o
   * processamento do webhook.
   */
  async downloadSignedDocument(providerEnvelopeId) {
    const documentsResponse = await this._request('GET', `/envelopes/${providerEnvelopeId}/documents`);
    const documents = (documentsResponse && documentsResponse.data) || [];
    if (documents.length === 0) return null;

    const document = documents[0];
    const downloadUrl = document.links && document.links.files && document.links.files.original;
    if (!downloadUrl) return null;

    // URL presignada — SEM os headers de autenticação da API (Authorization/Accept JSON:API),
    // que não se aplicam a um download direto de S3 e podem até fazer a assinatura da URL
    // presignada ser rejeitada.
    // M9-D245: o link veio na resposta do fornecedor (terceiro): a busca passa pelo guarda SSRF e o conteúdo vem da quarentena.
    const baixado = await fetchExternalUrl(downloadUrl, { flow: 'signature_download' });
    return { buffer: baixado.buffer, fileName: document.attributes && document.attributes.filename, quarantine: baixado.quarantine };
  }
}

module.exports = { ClicksignSignatureAdapter };
