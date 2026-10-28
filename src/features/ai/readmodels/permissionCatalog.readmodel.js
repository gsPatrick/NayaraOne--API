'use strict';

const { Permission } = require('../../../models');

/** Códigos de core.permissions (catálogo global, sem RLS). Usado no boot para validar a permissão de cada tool. */
async function loadPermissionCatalog() {
  const rows = await Permission.findAll({ attributes: ['code'], raw: true });
  return rows.map((r) => r.code);
}

module.exports = { loadPermissionCatalog };
