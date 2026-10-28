'use strict';

// Peças reutilizáveis dos schemas das tools iniciais (M9-D016). Os schemas de entrada seguem as regras da M9-D018: todo id é
// uuid, todo número tem faixa, toda lista tem items, e nenhum campo aceita companyId/groupId/userId.

const uuid = (description) => ({ type: 'string', format: 'uuid', description });
const text = (description, maxLength) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const limit = (description, maximum = 50) => ({ type: 'integer', minimum: 1, maximum, description });
const nullable = (type) => ({ type: [type, 'null'] });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const money = { type: 'object', properties: { count: { type: 'integer' }, total: { type: 'number' } }, required: ['count', 'total'] };

module.exports = { uuid, text, limit, nullable, obj, money };
