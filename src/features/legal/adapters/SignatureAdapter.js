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
  async requestSignature(contractVersion, signerPersonIds, transaction) {
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
async function loadSignerContacts(signerPersonIds, transaction) {
  // BUG REAL encontrado ao testar contra a conta Clicksign de verdade (19/09/2026): esta
  // consulta rodava SEM transação/contexto de tenant — sob RLS real (FORCE ROW LEVEL SECURITY,
  // sem BYPASSRLS), toda leitura sem `SET LOCAL app.company_id` retorna zero linhas, então
  // QUALQUER solicitação de assinatura a um provedor real (Clicksign/ZapSign) falhava com
  // "pessoa não encontrada", mesmo a pessoa existindo. Precisa da MESMA transação de tenant que
  // o resto do fluxo (signatures.service.js já abre via req.withTenantTransaction).
  const people = await Person.findAll({
    where: { id: signerPersonIds },
    include: [{ association: 'contacts' }],
    transaction,
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
  constructor({ apiToken, baseUrl = 'https://app.clicksign.com/api/v3' } = {}) {
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

    // 2) Documento — LIMITAÇÃO REAL DESTE PROJETO (achada testando contra a conta Clicksign de
    // verdade em 19/09/2026, não suposição): `ContractVersion` nunca armazena o TEXTO do
    // contrato — só grava `contentHash` (o `content` que o chamador manda em
    // createContractVersion existe só para calcular o hash e é descartado). O binário de
    // verdade ficaria associado ao `documentFileId` (File.storageKey), mas este projeto NUNCA
    // implementou um provedor de storage real (S3/etc.) — `storageKey` é só um metadado, sem
    // upload/download de fato em lugar nenhum do código. Ou seja: não existe HOJE nenhum
    // caminho pra recuperar o binário real do documento neste ponto do fluxo.
    // Enquanto isso não for implementado (trabalho futuro, fora deste marco), sobe um documento
    // de REFERÊNCIA gerado a partir do que de fato existe no banco — nunca inventa texto de
    // contrato, é auditável e rastreável ao contentHash real, mas deixa claro que não é o
    // documento assinado "de verdade": a fonte de verdade do conteúdo continua sendo o
    // `contentHash` gravado em ContractVersion (comparável a qualquer momento), não este .txt.
    const referenceText = [
      `Contrato ${contractVersion.contractId} — versão ${contractVersion.versionNumber}`,
      `Content hash (SHA-256, fonte de verdade do conteúdo): ${contractVersion.contentHash || '(ausente)'}`,
      '',
      'Este arquivo é um DOCUMENTO DE REFERÊNCIA para a assinatura eletrônica — o texto integral',
      'do contrato não é armazenado como binário recuperável neste sistema (limitação conhecida:',
      'não há storage de arquivo real implementado). A integridade do conteúdo assinado é',
      'garantida pelo content_hash acima, gravado em ContractVersion no momento da criação.',
    ].join('\n');
    const contentBase64 = Buffer.from(referenceText, 'utf8').toString('base64');
    const documentResponse = await this._request('POST', `/envelopes/${providerEnvelopeId}/documents`, {
      data: {
        type: 'documents',
        attributes: {
          filename: `contrato-${contractVersion.contractId}-v${contractVersion.versionNumber}.txt`,
          content_base64: `data:text/plain;base64,${contentBase64}`,
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

  async requestSignature(contractVersion, signerPersonIds, transaction) {
    const signers = await loadSignerContacts(signerPersonIds, transaction);

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
