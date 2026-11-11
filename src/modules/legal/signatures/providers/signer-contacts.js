'use strict';

const { Person } = require('../../../../models');
const AppError = require('../../../../utils/AppError');

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

module.exports = { loadSignerContacts };
