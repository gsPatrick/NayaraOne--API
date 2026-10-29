'use strict';

const { File, KnowledgeEntry } = require('../../../models');
const { canReadFile, resolveFileOwnership } = require('../../files/fileAccess.service');
const { CLASSIFICATION_RANK } = require('./retrieval.constants');

/**
 * Dupla checagem na leitura da ORIGEM (M9-D023, última regra): o chunk guarda uma cópia da permissão e da classificação da origem, que a
 * reconciliação atualiza em até `ia.rag.reconciliar_minutos`. Até lá, antes de devolver qualquer conteúdo, a origem é conferida de novo
 * com as permissões ATUAIS do ator: quem perdeu acesso (ou a origem que passou a ser mais sensível, revogada ou apagada) não recebe o
 * trecho, mesmo com o chunk ainda ACTIVE. Arquivo: a regra de acesso do módulo de arquivos; conhecimento: ainda HOMOLOGADO e ativo.
 * URL não tem controle de acesso de origem: vale a permissão do chunk. Devolve o conjunto de `tipo:id` liberados.
 */
const key = (type, id) => `${type}:${id}`;
const stricter = (a, b) => (!a ? b : (CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b));

async function fileAllowed(ctx, sourceId, classes, transaction) {
  const file = await File.findByPk(sourceId, { transaction });
  if (!file) return false;
  const auth = { userId: ctx.userId, companyId: ctx.companyId, permissions: ctx.permissions || [] };
  if (!(await canReadFile(file, auth, transaction))) return false;
  const ownership = await resolveFileOwnership(file.id, transaction);
  const current = stricter(file.classification || null, ownership.restricted ? 'RESTRICTED' : null);
  return !current || classes.includes(current);
}

async function knowledgeAllowed(ctx, sourceId, classes, transaction) {
  const entry = await KnowledgeEntry.findOne({ where: { id: sourceId, companyId: ctx.companyId }, transaction });
  return Boolean(entry && entry.status === 'HOMOLOGATED' && entry.isActive && classes.includes(entry.classification));
}

/** allowedSources(ctx, candidates, classes, transaction) => Set<'FILE:<id>' | ...> das fontes que o ator ainda pode ler. */
async function allowedSources(ctx, candidates, classes, transaction) {
  const unique = new Map(candidates.map((c) => [key(c.sourceType, c.sourceId), c]));
  const ok = new Set();
  for (const [k, c] of unique) {
    let allowed = true;
    if (c.sourceType === 'FILE') allowed = await fileAllowed(ctx, c.sourceId, classes, transaction);
    else if (c.sourceType === 'KNOWLEDGE_ENTRY') allowed = await knowledgeAllowed(ctx, c.sourceId, classes, transaction);
    if (allowed) ok.add(k);
  }
  return ok;
}

module.exports = { allowedSources, sourceKey: key };
