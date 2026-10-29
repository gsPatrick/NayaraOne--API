'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const settings = require('./calendar.settings');
const { TIMEZONE } = require('./calendar.constants');
const { parseListQuery } = require('./calendar.query');
const { allowedSourceTypes, deniedSourceKinds } = require('./calendar.visibility');
const repository = require('./calendar.repository');
const { presentItem, iso } = require('./calendar.presenter');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[key]);

/**
 * GET /calendar: lista itens da janela pedida, com filtros, paginação e visibilidade por origem (o item cuja origem o usuário
 * não pode ler é omitido e o total reflete a omissão). Janela padrão, tamanho de página e mapa de permissões vêm dos
 * parâmetros do administrador. `now` é injetável para teste.
 */
async function listCalendar(tenant, { permissions, query, now = new Date() }, transaction) {
  const windowDays = Number(await read(settings.WINDOW_DAYS_KEY, tenant, transaction)) || settings.CALENDAR_SETTING_DEFAULTS[settings.WINDOW_DAYS_KEY];
  const defaultPageSize = Number(await read(settings.PAGE_SIZE_KEY, tenant, transaction)) || settings.CALENDAR_SETTING_DEFAULTS[settings.PAGE_SIZE_KEY];
  const filters = parseListQuery(query, { now, windowDays, defaultPageSize });
  const permissionMap = settings.parsePermissionMap(await read(settings.PERMISSION_KEY, tenant, transaction));
  const allowed = allowedSourceTypes(permissions, permissionMap);
  const kindMap = settings.parseKindPermissionMap(await read(settings.KIND_PERMISSION_KEY, tenant, transaction));
  const denied = deniedSourceKinds(permissions, kindMap);
  const { rows, total } = await repository.listItems(filters, allowed, tenant, transaction, denied);
  return {
    items: rows.map((row) => presentItem(row, now)),
    pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) },
    meta: { from: iso(filters.from), to: iso(filters.to), timezone: TIMEZONE },
  };
}

module.exports = { listCalendar };
