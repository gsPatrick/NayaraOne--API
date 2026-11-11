'use strict';

const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const dedup = require('./personDedup.service');
const { readDedupParams } = require('./personDedup.settings');
const { assertWithinAttemptLimit, registrarTentativa } = require('./personLinks.service');

/**
 * Portão de deduplicação ANTES de criar a pessoa (livro §4 e CRMX-010 "Deduplicação antes de criar: pessoa semelhante exige revisão";
 * DI-M3PE-3 e DI-M3PE-4). Ordem e efeito:
 *   1. forte nesta empresa  -> 409 PERSON_DUPLICATE (nivel FORTE) com o cadastro existente; nada contorna;
 *   2. forte no grupo       -> 409 PERSON_TAX_ID_IN_GROUP (o controller acrescenta podeVincular): o caminho é o vínculo (POST /people/links);
 *   3. médio nesta empresa  -> 409 PERSON_DUPLICATE (nivel MEDIO) com os candidatos; criar mesmo assim é EXCEÇÃO: allowDuplicate + motivo
 *                              (mínimo do parâmetro) + permissão people:dedup:override; vira auditoria e par na fila de revisão;
 *   4. médio no grupo       -> 409 PERSON_CONTACT_IN_GROUP (sem id nem nome, conta como tentativa); mesma exceção do item 3;
 *   5. fraco nesta empresa  -> pela tela (modo EXIGIR): 409 PERSON_SIMILAR_REVIEW_REQUIRED com os candidatos, e só cria com
 *                              similarReviewed=true; nas criações automáticas (modo FILA) cria. Nos dois casos o par vai para a fila.
 * A recusa por permissão também fica na auditoria (gravada mesmo com o rollback).
 */
const OVERRIDE_PERMISSION = 'people:dedup:override';

const conflict = (message, code, details) => AppError.conflict(message, code, details);

function auditLater(transaction, entry) {
  transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), entry];
}

/** Exceção do match médio: motivo e permissão, ou recusa clara. */
function assertOverride(draft, ctx, params, transaction, candidatos) {
  if (ctx.podeForcarDuplicidade === false) {
    auditLater(transaction, {
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'people.person.duplicate_override_denied',
      entityType: 'Person', entityId: null, afterJson: { candidatos: candidatos.map((c) => c.personId) },
      reason: 'Criação mesmo com contato igual recusada: falta a permissão people:dedup:override.',
    });
    throw AppError.forbidden(
      'Para criar um cadastro com o mesmo telefone ou e-mail de outro é preciso a permissão de exceção de duplicidade. Peça a quem administra o cadastro.',
      'PERSON_DUPLICATE_OVERRIDE_DENIED', { required: OVERRIDE_PERMISSION }
    );
  }
  const motivo = String(draft.duplicateReason || '').trim();
  if (motivo.length < params.motivoMinimo) {
    const message = `Explique por que este cadastro não é a mesma pessoa (mínimo de ${params.motivoMinimo} caracteres).`;
    throw AppError.unprocessable(message, 'PERSON_DUPLICATE_REASON_REQUIRED', { fields: [{ field: 'duplicateReason', message }], motivoMinimo: params.motivoMinimo });
  }
  return motivo.slice(0, 500);
}

/**
 * Confere os cinco casos acima para o rascunho. Devolve o plano para depois da criação: { revisoes: [{ personId, nivel, motivo }],
 * excecao: { motivo, nivel } | null }, aplicado por registrarRevisoes na mesma transação.
 */
async function assertCreationAllowed(draft, ctx, transaction) {
  const params = await readDedupParams(ctx, transaction);
  const plano = { revisoes: [], excecao: null };

  const forte = await dedup.findStrongInCompany(draft.taxIdDigits, transaction);
  if (forte) {
    throw conflict('Já existe uma pessoa cadastrada com este CPF/CNPJ. Abra o cadastro existente em vez de criar outro.', 'PERSON_DUPLICATE',
      { nivel: 'FORTE', existingPersonId: forte.id, existente: { id: forte.id, legalName: forte.legalName } });
  }
  if (draft.taxIdDigits) {
    await assertWithinAttemptLimit(ctx, ctx.actorUserId, transaction);
    if (await dedup.taxIdInOtherCompany(draft.taxIdDigits, transaction)) {
      registrarTentativa(transaction, ctx, ctx.actorUserId, 'CPF_CNPJ_JA_NO_GRUPO');
      throw conflict(
        'Este CPF/CNPJ já tem cadastro em outra empresa do grupo. Para usar esse cadastro aqui, vincule-o a esta empresa informando o CPF/CNPJ e o nome como está no documento.',
        'PERSON_TAX_ID_IN_GROUP'
      );
    }
  }

  const medios = await dedup.findMediumCandidates(draft.contacts, params.ddi, transaction);
  if (medios.length) {
    if (!draft.allowDuplicate) {
      throw conflict('Já existe pessoa com o mesmo telefone ou e-mail. Revise o cadastro existente antes de criar outro.', 'PERSON_DUPLICATE',
        { nivel: 'MEDIO', existingPersonId: medios[0].personId, candidatos: medios, podeForcar: ctx.podeForcarDuplicidade !== false, motivoMinimo: params.motivoMinimo });
    }
    plano.excecao = { nivel: 'MEDIO', motivo: assertOverride(draft, ctx, params, transaction, medios) };
    medios.forEach((c) => plano.revisoes.push({ personId: c.personId, nivel: 'MEDIO', motivo: c.motivo }));
  } else if (params.contatoNoGrupo && draft.contacts && draft.contacts.length) {
    await assertWithinAttemptLimit(ctx, ctx.actorUserId, transaction);
    if (await dedup.contactInOtherCompany(draft.contacts, params.ddi, transaction)) {
      if (!draft.allowDuplicate) {
        registrarTentativa(transaction, ctx, ctx.actorUserId, 'CONTATO_JA_NO_GRUPO');
        throw conflict(
          'Este telefone ou e-mail já está no cadastro de uma pessoa de outra empresa do grupo. Se for a mesma pessoa, vincule o cadastro a esta empresa pelo CPF/CNPJ e o nome; se não for, crie com o motivo.',
          'PERSON_CONTACT_IN_GROUP', { nivel: 'MEDIO_GRUPO', podeForcar: ctx.podeForcarDuplicidade !== false, motivoMinimo: params.motivoMinimo }
        );
      }
      plano.excecao = { nivel: 'MEDIO_GRUPO', motivo: assertOverride(draft, ctx, params, transaction, []) };
    }
  }

  const fracos = (await dedup.findWeakDuplicateCandidates(draft, transaction)).filter((c) => !plano.revisoes.some((r) => r.personId === c.personId));
  if (fracos.length && ctx.modoSemelhante === 'EXIGIR' && draft.similarReviewed !== true) {
    throw conflict('Encontramos cadastro parecido (mesmo nome e mesma data de nascimento ou endereço). Revise antes de criar.', 'PERSON_SIMILAR_REVIEW_REQUIRED',
      { nivel: 'FRACO', candidatos: fracos });
  }
  fracos.forEach((c) => plano.revisoes.push({ personId: c.personId, nivel: 'FRACO', motivo: c.reason }));
  return plano;
}

/** Depois de criar: a exceção e cada par revisado vão para a auditoria e os pares para a fila de revisão (governance.review_queue_items). */
async function registrarRevisoes(person, plano, ctx, transaction) {
  if (!plano.excecao && !plano.revisoes.length) return;
  if (plano.excecao) {
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'people.person.duplicate_override', entityType: 'Person', entityId: person.id,
      afterJson: { nivel: plano.excecao.nivel, candidatos: plano.revisoes.filter((r) => r.nivel === 'MEDIO').map((r) => r.personId) },
      reason: `Cadastro criado mesmo com contato igual: ${plano.excecao.motivo}`,
    }, transaction);
  }
  const fracos = plano.revisoes.filter((r) => r.nivel === 'FRACO');
  if (fracos.length) {
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'people.person.similar_reviewed', entityType: 'Person', entityId: person.id,
      afterJson: { candidatos: fracos.map((r) => ({ personId: r.personId, motivo: r.motivo })), confirmadoNaTela: ctx.modoSemelhante === 'EXIGIR' },
      reason: ctx.modoSemelhante === 'EXIGIR' ? 'Cadastro parecido revisado e confirmado antes de criar.' : 'Cadastro parecido criado automaticamente; par enviado à fila de revisão.',
    }, transaction);
  }
  const { insertCandidate } = require('../core-governance/data-quality/merge.repository');
  const { loadConfig } = require('../core-governance/data-quality/merge.detection');
  const { scores } = await loadConfig(ctx, transaction);
  for (const r of plano.revisoes) {
    const reason = r.nivel === 'MEDIO' ? 'PERSON_CONTACT_AT_CREATE' : 'PERSON_SIMILAR_AT_CREATE';
    const score = r.nivel === 'MEDIO' ? scores.PERSON_NAME_CONTACT : scores.PERSON_NAME_BIRTH;
    await insertCandidate(ctx, { entityType: 'PERSON', primaryId: person.id, secondaryId: r.personId, reason, score }, transaction);
  }
}

/**
 * Consulta da tela ANTES de criar (POST /people/duplicates/check): o que o portão encontraria, sem gravar a pessoa. O que existe só em outra
 * empresa do grupo volta como verdadeiro/falso, passa pelo limite de tentativas do vínculo e, quando é verdadeiro, conta como tentativa
 * (auditoria people.person.link_attempt gravada na própria consulta).
 */
async function checkDraft(draft, ctx, transaction) {
  const { onlyDigits } = require('./personDocumentFormat.service');
  const params = await readDedupParams(ctx, transaction);
  const taxIdDigits = onlyDigits(draft.taxIdNormalized) || null;
  const forte = await dedup.findStrongInCompany(taxIdDigits, transaction);
  const medios = forte ? [] : await dedup.findMediumCandidates(draft.contacts, params.ddi, transaction);
  const fracos = forte ? [] : (await dedup.findWeakDuplicateCandidates(draft, transaction)).filter((c) => !medios.some((m) => m.personId === c.personId));
  let documentoNoGrupo = false;
  let contatoNoGrupo = false;
  if (!forte && (taxIdDigits || (params.contatoNoGrupo && !medios.length && draft.contacts && draft.contacts.length))) {
    await assertWithinAttemptLimit(ctx, ctx.actorUserId, transaction);
    documentoNoGrupo = taxIdDigits ? await dedup.taxIdInOtherCompany(taxIdDigits, transaction) : false;
    contatoNoGrupo = !documentoNoGrupo && params.contatoNoGrupo && !medios.length ? await dedup.contactInOtherCompany(draft.contacts, params.ddi, transaction) : false;
    if (documentoNoGrupo || contatoNoGrupo) {
      const resultado = documentoNoGrupo ? 'CPF_CNPJ_JA_NO_GRUPO' : 'CONTATO_JA_NO_GRUPO';
      await registrarAuditoria({ groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'people.person.link_attempt', entityType: 'Person',
        entityId: null, afterJson: { resultado, consulta: 'ANTES_DE_CRIAR' }, reason: 'Consulta de duplicidade antes de criar: o dado já existe em outra empresa do grupo.' }, transaction);
    }
  }
  return {
    forte: { nestaEmpresa: forte ? { id: forte.id, legalName: forte.legalName } : null, noGrupo: documentoNoGrupo },
    medio: { candidatos: medios, noGrupo: contatoNoGrupo, podeForcar: ctx.podeForcarDuplicidade !== false, motivoMinimo: params.motivoMinimo },
    fraco: { candidatos: fracos },
  };
}

module.exports = { OVERRIDE_PERMISSION, assertCreationAllowed, registrarRevisoes, checkDraft };
