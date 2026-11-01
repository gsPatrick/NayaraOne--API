'use strict';

// M9-D800 (R5-M2): real_estate.property_addresses não tem empresa própria (exceção de RLS, DI-D800-R4L3-1). O isolamento então é
// do serviço: um addressId só vale se algum imóvel DA MESMA EMPRESA já o usa. Inexistente e de outra empresa dão a mesma resposta.
const { Property } = require('../../models');
const AppError = require('../../utils/AppError');

async function assertAddressBelongsToCompany(addressId, companyId, transaction) {
  if (addressId === null || addressId === undefined) return null;
  const owner = typeof addressId === 'string' && /^[0-9a-f-]{36}$/i.test(addressId)
    ? await Property.findOne({ where: { addressId, companyId }, attributes: ['id'], transaction })
    : null;
  if (!owner) throw AppError.notFound('Endereço não encontrado.', 'PROPERTY_ADDRESS_NOT_FOUND');
  return addressId;
}

module.exports = { assertAddressBelongsToCompany };
