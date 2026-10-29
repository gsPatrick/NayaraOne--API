'use strict';

const { CANCEL } = require('./sources.constants');
const { clipTitle, emptyResult, transition, itemDraft } = require('./draft');

/**
 * Ciclo de vida de uma fonte operacional (M9-D802 §3.1.1): de uma função `toFields(payload, ctx)` (campos do item ou null quando a origem
 * não tem prazo) gera os quatro mapeadores de evento — UPSERT, DONE, CANCELLED e OPEN (reabertura). Os eventos de fechamento e de
 * reabertura também levam o rascunho do item, para o projetor criar o item já no estado final quando ele ainda não existia (matriz
 * de §3.2.1, coluna "item inexistente"). Funções puras, sem banco.
 */
function lifecycle(sourceType, toFields) {
  const build = (p, ctx, status) => {
    const fields = toFields(p, ctx);
    return fields ? itemDraft(ctx, { sourceType, sourceId: p.id, status, ...fields, title: clipTitle(fields.title, 'Item do calendário') }) : null;
  };
  const withTransition = (status, reason) => (p, ctx) => {
    const out = emptyResult();
    const draft = build(p, ctx, status);
    if (draft) out.items.push(draft);
    out.transitions.push(transition(sourceType, p.id, status, status === 'CANCELLED' ? reason || CANCEL.SOURCE_CANCELLED : null));
    return out;
  };
  return {
    upsert: (p, ctx) => {
      const out = emptyResult();
      const draft = build(p, ctx, 'OPEN');
      if (draft) out.items.push(draft);
      else out.transitions.push(transition(sourceType, p.id, 'CANCELLED', CANCEL.NO_DUE_DATE));
      return out;
    },
    done: withTransition('DONE'),
    cancelled: withTransition('CANCELLED'),
    deleted: withTransition('CANCELLED', CANCEL.SOURCE_DELETED),
    reopen: withTransition('OPEN'),
  };
}

/** Responsável: usuário da origem ou, quando nulo, o papel configurado para a fonte (`owner_team`). */
function ownerOf(userId, sourceType, ctx) {
  const team = (ctx.teamMap && ctx.teamMap[sourceType]) || null;
  return userId ? { ownerUserId: userId, ownerTeam: null } : { ownerUserId: null, ownerTeam: team };
}

module.exports = { lifecycle, ownerOf };
