'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Fechamento M5 (Caderno §11 "Cada ambiente contém itens estruturados"; Guia §9 InspectionItem { roomCode, itemCode }).
 * Ambiente e item têm código (MAIÚSCULAS, dígitos, "_" e "-", até 60). Quando a chamada não traz o código (cadastros
 * antigos e telas que mandam só o nome "Sala — piso"), o servidor deriva: o que vem antes de " — " é o ambiente e o
 * resto é o item; sem separador, o ambiente é o padrão configurado `legal.inspection_default_room_code` (padrão GERAL).
 */
const CODE_RE = /^[A-Z0-9_-]{1,60}$/;
const DEFAULT_ROOM_CODE = 'GERAL';

function slug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function normalizeCode(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw AppError.badRequest(`"${field}" deve ter só letras maiúsculas, dígitos, "_" ou "-" (até 60).`, 'LEGAL_INSPECTION_ITEM_VALIDATION');
  }
  return code;
}

function resolveItemCodes({ itemName, roomCode, itemCode }, defaultRoomCode = DEFAULT_ROOM_CODE) {
  const parts = String(itemName || '').split(/\s+[—–-]\s+/);
  const derivedRoom = parts.length > 1 ? slug(parts[0]) : null;
  const derivedItem = slug(parts.length > 1 ? parts.slice(1).join(' ') : itemName);
  return {
    roomCode: normalizeCode(roomCode, 'roomCode') || derivedRoom || defaultRoomCode,
    itemCode: normalizeCode(itemCode, 'itemCode') || derivedItem || 'ITEM',
  };
}

/** Chave de pareamento entrada x saída: ambiente + código do item. */
function pairKey(item) {
  return `${item.roomCode || DEFAULT_ROOM_CODE}|${item.itemCode || slug(item.itemName)}`;
}

module.exports = { resolveItemCodes, pairKey, slug, DEFAULT_ROOM_CODE };
