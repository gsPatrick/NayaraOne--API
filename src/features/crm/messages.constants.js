'use strict';

/**
 * Listas fechadas e formatos da mensagem do CRM (`crm.messages`), numa fonte só: o serviço confere com elas e o esquema das rotas de mensagem
 * (messages.schema.js, DI-M9R-11) as usa como estão. Cada formato é o do banco (coluna ou CHECK), para que nenhum valor aceito pela API seja
 * recusado pelo banco (o que virava 500).
 */
const DIRECTIONS = Object.freeze(['INBOUND', 'OUTBOUND']);
const AUTHOR_TYPES = Object.freeze(['CLIENT', 'NAY', 'EMPLOYEE']);
/**
 * M3-24 (correção): `channel` era gravado sem NENHUMA validação (a coluna é só um VARCHAR(32) sem CHECK), então um typo — "whatsap", "zap",
 * "" — entrava no histórico e quebrava silenciosamente qualquer filtro/relatório por canal. Enum fechado, mesmo padrão de `direction`/`authorType`.
 */
const CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL', 'SMS', 'PHONE', 'IN_PERSON', 'PORTAL', 'INSTAGRAM', 'OTHER']);
/** Status de entrega: o conjunto da CHECK `messages_delivery_status_ck` (migration 20260101000763). */
const DELIVERY_STATUSES = Object.freeze(['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'UNKNOWN']);
/** Status da mensagem (`status`, varchar(32)): `RECEIVED` (o padrão da coluna) e os status de entrega, os únicos que algum caminho grava. */
const MESSAGE_STATUSES = Object.freeze(['RECEIVED', ...DELIVERY_STATUSES]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CHECK `messages_action_key_format_ck` (migration 20260101000755): sha256 em hexadecimal minúsculo. */
const ACTION_KEY = /^[0-9a-f]{64}$/;
/** CHECK `messages_purpose_format_ck` (migration 20260101000753), gravada em maiúsculas: aceita minúsculas na entrada. */
const PURPOSE = /^[A-Za-z0-9_]{2,40}$/;
/** Tamanho das colunas de texto que a entrada alimenta (src/models/Message.js). */
const COLUMN_LIMITS = Object.freeze({ externalMessageId: 128, actionKey: 64, purpose: 40, status: 32 });

module.exports = { DIRECTIONS, AUTHOR_TYPES, CHANNELS, DELIVERY_STATUSES, MESSAGE_STATUSES, UUID, ACTION_KEY, PURPOSE, COLUMN_LIMITS };
