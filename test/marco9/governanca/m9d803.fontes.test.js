'use strict';

// M9-D803 — regras puras das fontes CONSTRUCTION e GUARANTEE (sem banco): evento -> item/fechamento, prazo, dono, deep link,
// isolamento por empresa, evento desconhecido e visibilidade por permissão da origem. A prova ponta a ponta com o projetor
// é do teste 11 de M9-D802.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapSourceEvent, SOURCE_EVENT_TYPES } = require('../../../src/features/core-governance/calendar/sources');
const { endOfDayInZone, addMonthsToDateKey } = require('../../../src/features/core-governance/calendar/sources/time');
const { projectWarrantySourceId } = require('../../../src/features/core-governance/calendar/sources/ids');
const { allowedSourceTypes, deniedSourceKinds } = require('../../../src/features/core-governance/calendar/calendar.visibility');
const settings = require('../../../src/features/core-governance/calendar/calendar.settings');
const { isValidDeepLink } = require('../../../src/features/core-governance/calendar/calendar.deeplinks');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ctx = { companyId: COMPANY, severityMap: settings.parseSeverityMap(settings.CALENDAR_SETTING_DEFAULTS[settings.SEVERITY_KEY]) };
const ev = (eventType, payload, extra = {}) => ({ id: '33333333-3333-4333-8333-333333333333', eventType, companyId: COMPANY, occurredAt: '2026-10-28T12:00:00Z', payload, ...extra });
const ID = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

test('m9d803 etapa de obra com prazo vira item CONSTRUCTION e conclusão fecha', () => {
  const stage = { projectId: ID(1), stageId: ID(2), projectName: 'Alfa', stageName: 'Reboco', endsAt: '2026-11-12T20:00:00.000Z', status: 'IN_PROGRESS', responsibleUserId: OWNER };
  const out = mapSourceEvent(ev('project.stage.updated', stage), ctx);
  assert.equal(out.items.length, 1);
  const [item] = out.items;
  assert.equal(item.sourceType, 'CONSTRUCTION');
  assert.equal(item.sourceId, ID(2));
  assert.equal(item.status, 'OPEN');
  assert.equal(item.severity, 'INFO');
  assert.equal(item.ownerUserId, OWNER);
  assert.equal(item.dueAt.toISOString(), '2026-11-12T20:00:00.000Z');
  assert.equal(item.deepLink, `/painel/obras/${ID(1)}/etapas/${ID(2)}`);
  assert.ok(isValidDeepLink(item.deepLink));
  const done = mapSourceEvent(ev('project.stage.completed', { id: ID(2), projectId: ID(1), name: 'Reboco' }), ctx);
  assert.deepEqual(done.items, []);
  assert.deepEqual(done.transitions, [{ sourceType: 'CONSTRUCTION', sourceId: ID(2), status: 'DONE', cancelReason: null }]);
  const noDate = mapSourceEvent(ev('project.stage.updated', { ...stage, endsAt: null }), ctx);
  assert.deepEqual(noDate.transitions, [{ sourceType: 'CONSTRUCTION', sourceId: ID(2), status: 'CANCELLED', cancelReason: 'NO_DUE_DATE' }]);
});

test('m9d803 prazo final da obra vira item e project.closed fecha', () => {
  const created = mapSourceEvent(ev('project.created', { id: ID(1), name: 'Alfa', status: 'PLANNED', endsAtPlanned: '2026-12-15T03:00:00.000Z', responsibleUserId: OWNER }), ctx);
  const [item] = created.items;
  assert.equal(item.sourceType, 'CONSTRUCTION');
  assert.equal(item.sourceId, ID(1));
  assert.equal(item.deepLink, `/painel/obras/${ID(1)}`);
  // 15/12 às 00:00 de Brasília (03:00Z) -> prazo da obra vence 23:59:59 de Brasília do dia 15 (02:59:59Z do dia 16).
  assert.equal(item.dueAt.toISOString(), '2026-12-16T02:59:59.000Z');
  for (const type of ['project.closed', 'project.delivered']) {
    const out = mapSourceEvent(ev(type, { id: ID(1), name: 'Alfa', status: 'CLOSED' }), ctx);
    assert.deepEqual(out.transitions.map((t) => [t.sourceId, t.status]), [[ID(1), 'DONE']]);
  }
  const cancelled = mapSourceEvent(ev('construction.project.status_changed', { id: ID(1), toStatus: 'CANCELLED' }), ctx);
  assert.deepEqual(cancelled.transitions.map((t) => [t.status, t.cancelReason]), [['CANCELLED', 'SOURCE_CANCELLED']]);
  const schedule = mapSourceEvent(ev('project.schedule.updated', { id: ID(1), name: 'Alfa', status: 'ACTIVE', endsAtPlanned: '2026-12-20T03:00:00.000Z' }), ctx);
  assert.equal(schedule.items[0].dueAt.toISOString(), '2026-12-21T02:59:59.000Z');
});

test('m9d803 fiança com ends_at vira item GUARANTEE às 23:59:59 de São Paulo', () => {
  const out = mapSourceEvent(ev('legal.guarantee.created', { id: ID(3), contractId: ID(4), guaranteeType: 'DEPOSIT', endsAt: '2026-11-30', status: 'ACTIVE', ownerUserId: OWNER, contractNumber: '2031' }), ctx);
  const [item] = out.items;
  assert.equal(item.sourceType, 'GUARANTEE');
  assert.equal(item.sourceKind, 'LEGAL_GUARANTEE');
  assert.equal(item.dueAt.toISOString(), '2026-12-01T02:59:59.000Z');
  assert.equal(item.severity, 'WARNING');
  assert.equal(item.ownerUserId, OWNER);
  assert.equal(item.deepLink, `/painel/juridico/contratos/${ID(4)}`);
  assert.equal(endOfDayInZone('2026-11-30').toISOString(), '2026-12-01T02:59:59.000Z');
  const inactive = mapSourceEvent(ev('legal.guarantee.updated', { id: ID(3), contractId: ID(4), endsAt: '2026-11-30', status: 'RELEASED' }), ctx);
  assert.deepEqual(inactive.items, []);
});

test('m9d803 substituição de garantia fecha o item antigo e abre o novo', () => {
  const out = mapSourceEvent(ev('legal.guarantee.replaced', {
    id: ID(3), contractId: ID(4), replacedByGuaranteeId: ID(5),
    newGuarantee: { id: ID(5), contractId: ID(4), guaranteeType: 'INSURANCE', endsAt: '2027-05-10', status: 'ACTIVE', ownerUserId: OWNER },
  }), ctx);
  assert.deepEqual(out.transitions.map((t) => [t.sourceId, t.status]), [[ID(3), 'DONE']]);
  assert.deepEqual(out.items.map((i) => [i.sourceId, i.status, i.sourceKind]), [[ID(5), 'OPEN', 'LEGAL_GUARANTEE']]);
});

test('m9d803 caso em garantia usa warranty_deadline_at e responsável do caso', () => {
  const out = mapSourceEvent(ev('warranty.case.opened', { id: ID(6), propertyId: ID(7), status: 'OPEN', warrantyDeadlineAt: '2026-11-20T15:30:00.000Z', responsibleUserId: OWNER, description: 'Infiltração' }), ctx);
  const [item] = out.items;
  assert.equal(item.sourceKind, 'WARRANTY_CASE');
  assert.equal(item.dueAt.toISOString(), '2026-11-20T15:30:00.000Z');
  assert.equal(item.ownerUserId, OWNER);
  assert.equal(item.deepLink, `/painel/obras/pos-obra/${ID(6)}`);
  const closed = mapSourceEvent(ev('warranty.case.closed', { id: ID(6) }), ctx);
  assert.deepEqual(closed.transitions.map((t) => t.status), ['DONE']);
});

test('m9d803 project.warranty_started com warrantyEndsAt cria PROJECT_WARRANTY', () => {
  const out = mapSourceEvent(ev('project.warranty_started', { id: ID(1), name: 'Alfa', status: 'WARRANTY', warrantyEndsAt: '2031-10-01', responsibleUserId: OWNER }), ctx);
  const [item] = out.items;
  assert.equal(item.sourceKind, 'PROJECT_WARRANTY');
  assert.equal(item.sourceId, projectWarrantySourceId(ID(1)));
  assert.notEqual(item.sourceId, ID(1));
  assert.match(item.sourceId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(item.dueAt.toISOString(), '2031-10-02T02:59:59.000Z');
  assert.equal(item.deepLink, `/painel/obras/${ID(1)}`);
  assert.equal(projectWarrantySourceId(ID(1)), item.sourceId, 'determinístico');
  assert.equal(addMonthsToDateKey('2026-08-31', 6), '2027-02-28');
});

test('m9d803 evento de outra empresa é descartado e tipo desconhecido vai para dead-letter', () => {
  assert.throws(() => mapSourceEvent(ev('project.created', { id: ID(1) }, { companyId: '99999999-9999-4999-8999-999999999999' }), ctx),
    (err) => err.code === 'GOV_CALENDAR_TENANT_MISMATCH');
  assert.throws(() => mapSourceEvent(ev('project.explodiu', {}), ctx), (err) => err.code === 'GOV_CALENDAR_EVENT_UNKNOWN');
  assert.ok(SOURCE_EVENT_TYPES.includes('legal.guarantee.ended') && SOURCE_EVENT_TYPES.includes('project.stage.updated'));
});

test('m9d803 usuário sem permissão de obras não vê item CONSTRUCTION nem garantia de obra', () => {
  const map = settings.parsePermissionMap(settings.CALENDAR_SETTING_DEFAULTS[settings.PERMISSION_KEY]);
  const kinds = settings.parseKindPermissionMap(settings.CALENDAR_SETTING_DEFAULTS[settings.KIND_PERMISSION_KEY]);
  const juridico = allowedSourceTypes(['legal:read'], map);
  assert.ok(!juridico.includes('CONSTRUCTION'));
  assert.ok(juridico.includes('GUARANTEE'), 'legal:read abre a origem GUARANTEE');
  assert.deepEqual(deniedSourceKinds(['legal:read'], kinds).sort(), ['PROJECT_WARRANTY', 'WARRANTY_CASE'], 'só jurídico não vê dados de obra');
  const obras = allowedSourceTypes(['construction:read'], map);
  assert.ok(obras.includes('CONSTRUCTION') && obras.includes('GUARANTEE'));
  assert.deepEqual(deniedSourceKinds(['construction:read'], kinds), ['LEGAL_GUARANTEE'], 'só obras não vê fiança de contrato');
  assert.deepEqual(deniedSourceKinds(['legal:read', 'construction:read'], kinds), []);
  assert.deepEqual(settings.parseKindPermissionMap('LEGAL_GUARANTEE=legal:read|finance:read, XPTO=a'), { LEGAL_GUARANTEE: ['legal:read', 'finance:read'] });
});

test('m9d803 legal.guarantee.ended fecha o item e warranty.case.escalated só sobe a severidade', () => {
  const ended = mapSourceEvent(ev('legal.guarantee.ended', { id: ID(3), contractId: ID(4), status: 'RELEASED', reason: 'RELEASED' }), ctx);
  assert.deepEqual(ended.transitions.map((t) => [t.status, t.cancelReason]), [['DONE', null]]);
  const deleted = mapSourceEvent(ev('legal.guarantee.ended', { id: ID(3), reason: 'DELETED' }), ctx);
  assert.deepEqual(deleted.transitions.map((t) => [t.status, t.cancelReason]), [['CANCELLED', 'SOURCE_DELETED']]);
  const esc = mapSourceEvent(ev('warranty.case.escalated', { id: ID(6), escalationLevel: 'CRITICAL', warrantyDeadlineAt: '2026-11-20T15:30:00.000Z', responsibleUserId: OWNER, description: 'x' }), ctx);
  assert.deepEqual(esc.transitions, []);
  assert.equal(esc.items.length, 1);
  assert.equal(esc.items[0].severity, 'CRITICAL');
  assert.equal(esc.items[0].preserveStatus, true, 'o projetor não reabre item fechado');
  assert.equal(esc.items[0].dueAt.toISOString(), '2026-11-20T15:30:00.000Z');
});

test('m9d803 parâmetros do administrador: prazo da garantia da obra e hora da varredura têm padrão e limites', () => {
  const schema = settings.CALENDAR_SETTINGS_SCHEMA;
  assert.deepEqual(schema[settings.WARRANTY_MONTHS_KEY], { type: 'integer', min: 1, max: 600 });
  assert.deepEqual(schema[settings.BACKFILL_HOUR_KEY], { type: 'integer', min: 0, max: 23 });
  assert.equal(settings.CALENDAR_SETTING_DEFAULTS[settings.WARRANTY_MONTHS_KEY], 60);
  assert.equal(settings.CALENDAR_SETTING_DEFAULTS[settings.BACKFILL_HOUR_KEY], 6);
});
