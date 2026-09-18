'use strict';

const crypto = require('crypto');
const { Person } = require('../../../models');
const AppError = require('../../../utils/AppError');

/**
 * SignatureAdapter — contrato de integração com provedores de assinatura eletrônica.
 *
 * Este arquivo define apenas o `SandboxSignatureAdapter`: um mock local que NÃO faz nenhuma
 * chamada HTTP real. Ele existe para permitir o fluxo completo de negócio (iniciar
 * assinatura, receber "webhook") ser testado e usado em desenvolvimento sem depender de
 * credenciais de provedor real.
 *
 * Em produção, um adapter real (ex.: `ClicksignSignatureAdapter`, `ZapSignSignatureAdapter`)
 * implementaria a mesma interface (`requestSignature(contractVersion, signers)`) usando
 * credenciais vindas de variáveis de ambiente (ex.: CLICKSIGN_API_TOKEN, ZAPSIGN_API_TOKEN —
 * ainda não configuradas neste projeto) e faria as chamadas HTTP reais ao provedor, retornando
 * o `externalSignatureId` real emitido por ele. A troca de adapter seria feita por
 * configuração (ex.: SIGNATURE_PROVIDER=clicksign|zapsign|sandbox), nunca alterando o código
 * de signatures.service.js — só a implementação injetada.
 */
class SandboxSignatureAdapter {
  /**
   * requestSignature — "envia" a versão do contrato para assinatura de uma lista de
   * signatários. Retorna um mapa personId -> externalSignatureId (fake, gerado localmente).
   * Não persiste nada e não faz I/O — a persistência de Signature é responsabilidade do
   * chamador (signatures.service.js).
   */
  async requestSignature(contractVersion, signerPersonIds) {
    const externalSignatureIdsByPerson = {};
    for (const personId of signerPersonIds) {
      externalSignatureIdsByPerson[personId] = `sandbox-sig-${crypto.randomUUID()}`;
    }
    return {
      providerEnvelopeId: `sandbox-envelope-${crypto.randomUUID()}`,
      externalSignatureIdsByPerson,
    };
  }

  // Sandbox não tem provedor real por trás — "consulta de status" sempre responde "pendente"
  // (nunca finaliza sozinho; a confirmação em sandbox vem de handleSignatureWebhook simulado).
  async getStatus(providerEnvelopeId) {
    return { providerEnvelopeId, status: 'PENDING', raw: null };
  }

  // Sandbox aceita cancelamento sempre (não há efeito colateral externo a desfazer).
  async cancel(providerEnvelopeId) {
    return { providerEnvelopeId, cancelled: true, raw: null };
  }
}

/**
 * _loadSignerContacts — busca nome/e-mail reais dos signatários (Person + PersonContact) para
 * os adapters de provedor real, que precisam desses dados para criar o signatário no
 * envelope. Nunca inventa e-mail: se a pessoa não tiver um contato EMAIL cadastrado, o
 * adapter falha explicitamente (AppError) em vez de mandar um payload inválido ao provedor.
 */
async function loadSignerContacts(signerPersonIds) {
  const people = await Person.findAll({
    where: { id: signerPersonIds },
    include: [{ association: 'contacts' }],
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  return signerPersonIds.map((personId) => {
    const person = byId.get(personId);
    if (!person) {
      throw AppError.notFound(`Pessoa ${personId} não encontrada para montar signatário do envelope.`, 'LEGAL_SIGNATURE_PERSON_NOT_FOUND');
    }
    const contacts = person.contacts || [];
    const emailContact = contacts.find((c) => c.contactType === 'EMAIL' && c.isPrimary) || contacts.find((c) => c.contactType === 'EMAIL');
    if (!emailContact) {
      throw AppError.badRequest(
        `Pessoa ${personId} não possui e-mail cadastrado — obrigatório para enviar assinatura a um provedor real.`,
        'LEGAL_SIGNATURE_EMAIL_REQUIRED'
      );
    }
    return { personId, name: person.legalName, email: emailContact.valueNormalized };
  });
}

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
 * - `.txt` é um formato aceito de documento — usado aqui porque este marco tem apenas o
 *   `content` (texto) da ContractVersion, não um binário PDF já gerado.
 */
class ClicksignSignatureAdapter {
  constructor({ apiToken, baseUrl = 'https://sandbox.clicksign.com/api/v3' } = {}) {
    if (!apiToken) {
      throw AppError.internal('ClicksignSignatureAdapter requer apiToken configurado.', 'LEGAL_SIGNATURE_PROVIDER_CONFIG_MISSING');
    }
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
  }

  // Centraliza a chamada HTTP — isola a camada de transporte para facilitar ajuste futuro
  // (retry, logging, mudança de endpoint) sem tocar na lógica de negócio do adapter.
  async _request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  async requestSignature(contractVersion, signerPersonIds) {
    const signers = await loadSignerContacts(signerPersonIds);

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

    // 2) Documento — sobe o CONTEÚDO da versão do contrato como .txt (base64). `metadata`
    // carrega o content_hash para amarrar o documento no provedor à versão/hash exato do
    // contrato que originou a assinatura — sem isso, uma consulta manual no painel do Clicksign
    // não teria como confirmar QUAL versão do contrato aquele documento representa.
    const contentBase64 = Buffer.from(contractVersion.content || '', 'utf8').toString('base64');
    const documentResponse = await this._request('POST', `/envelopes/${providerEnvelopeId}/documents`, {
      data: {
        type: 'documents',
        attributes: {
          filename: `contrato-${contractVersion.contractId}-v${contractVersion.versionNumber}.txt`,
          content_base64: `data:text/plain;base64,${contentBase64}`,
          metadata: JSON.stringify({ contentHash: contractVersion.contentHash || null, contractVersionId: contractVersion.id }),
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

    // 4) Ativa o envelope — sem isso o Clicksign nunca dispara o convite de assinatura.
    await this._request('PATCH', `/envelopes/${providerEnvelopeId}`, {
      data: { id: providerEnvelopeId, type: 'envelopes', attributes: { status: 'running' } },
    });

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
   * cancel — cancela o envelope no Clicksign (PATCH status -> "canceled").
   * DECISÃO DE ENGENHARIA — não confirmado na documentação pública se "canceled" é o valor
   * exato aceito por PATCH (só "running" está documentado explicitamente); manter e validar
   * contra a conta real na primeira tentativa de cancelamento.
   */
  async cancel(providerEnvelopeId) {
    const result = await this._request('PATCH', `/envelopes/${providerEnvelopeId}`, {
      data: { type: 'envelopes', id: providerEnvelopeId, attributes: { status: 'canceled' } },
    });
    return { providerEnvelopeId, cancelled: true, raw: result };
  }
}

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
  }

  async _request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  async requestSignature(contractVersion, signerPersonIds) {
    const signers = await loadSignerContacts(signerPersonIds);

    // DECISÃO DE ENGENHARIA: `/docs/` do ZapSign normalmente exige `base64_pdf` ou `url_pdf`;
    // aqui usamos apenas um identificador textual a partir do hash de conteúdo, na ausência do
    // binário do documento neste ponto do fluxo — confirmar contra documentação/conta real.
    const doc = await this._request('POST', '/docs/', {
      name: `Contrato ${contractVersion.contractId} v${contractVersion.versionNumber}`,
      external_id: contractVersion.contentHash || contractVersion.id,
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
}

module.exports = { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter };
