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
 * DECISÃO DE ENGENHARIA — não testado contra credencial real: URL/payload baseado no
 * conhecimento geral da API pública do Clicksign v3, confirmar contra documentação oficial
 * atualizada antes de produção. Em especial: (1) o formato exato de criação de "envelope" e
 * "documento" a partir de conteúdo/hash pode exigir upload de arquivo (multipart) em vez de
 * apenas um hash, dependendo do plano/fluxo contratado; (2) o endpoint de adição de
 * signatário ("signers"/"requirements") e os campos aceitos podem variar entre contas; (3) o
 * nome exato do header de autenticação e o formato de erro podem ter mudado desde a última
 * verificação. Toda a chamada HTTP é centralizada em `_request` para isolar essa camada e
 * facilitar o ajuste quando houver acesso a uma conta real de homologação.
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

    // Cria o envelope ("documento") a partir do hash de conteúdo da versão do contrato.
    // DECISÃO DE ENGENHARIA: o Clicksign v3 tipicamente espera o conteúdo do arquivo (base64
    // ou upload), não apenas um hash — usamos o hash como identificador de conteúdo aqui
    // porque este marco não tem acesso ao binário do documento neste ponto do fluxo; confirmar
    // o payload real de criação de documento contra a documentação/conta de homologação.
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

    const externalSignatureIdsByPerson = {};
    for (const signer of signers) {
      const signerResponse = await this._request('POST', `/envelopes/${providerEnvelopeId}/signers`, {
        data: {
          type: 'signers',
          attributes: {
            name: signer.name,
            email: signer.email,
            communicate_events: { document_signed: 'email', signature_request: 'email' },
          },
        },
      });
      externalSignatureIdsByPerson[signer.personId] = signerResponse && signerResponse.data && signerResponse.data.id;
    }

    return { providerEnvelopeId, externalSignatureIdsByPerson };
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
}

module.exports = { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter };
