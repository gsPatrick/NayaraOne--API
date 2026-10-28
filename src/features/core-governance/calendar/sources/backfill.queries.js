'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/**
 * Leituras da carga inicial/varredura do Calendário (M9-D803 §3.4): só o que está ABERTO em cada origem. Roda na transação do
 * chamador com o tenant já aplicado (RLS); o filtro por company_id é redundante de propósito (defesa em profundidade).
 */
const select = (sql, companyId, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements: { companyId } });

const openStages = (companyId, transaction) => select(
  `SELECT s.id AS "stageId", s.project_id AS "projectId", s.name AS "stageName", s.ends_at AS "endsAt", s.status,
          p.name AS "projectName", p.responsible_user_id AS "responsibleUserId"
     FROM construction.project_stages s
     JOIN construction.projects p ON p.id = s.project_id AND p.deleted_at IS NULL
    WHERE s.company_id = :companyId AND s.deleted_at IS NULL AND s.ends_at IS NOT NULL AND s.status <> 'DONE'
      AND p.status NOT IN ('CANCELLED', 'CLOSED')`, companyId, transaction);

const openProjects = (companyId, transaction) => select(
  `SELECT id AS "projectId", name, ends_at_planned AS "endsAtPlanned", status, responsible_user_id AS "responsibleUserId"
     FROM construction.projects
    WHERE company_id = :companyId AND deleted_at IS NULL AND ends_at_planned IS NOT NULL
      AND status NOT IN ('DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED')`, companyId, transaction);

const activeGuarantees = (companyId, transaction) => select(
  `SELECT g.id, g.contract_id AS "contractId", g.guarantee_type AS "guaranteeType", g.ends_at::text AS "endsAt", g.status,
          c.created_by AS "ownerUserId", c.contract_number AS "contractNumber"
     FROM legal.guarantees g
     JOIN legal.contracts c ON c.id = g.contract_id
    WHERE g.company_id = :companyId AND g.deleted_at IS NULL AND g.status = 'ACTIVE' AND g.ends_at IS NOT NULL`, companyId, transaction);

const openWarrantyCases = (companyId, transaction) => select(
  `SELECT id, description, warranty_deadline_at AS "warrantyDeadlineAt", responsible_user_id AS "responsibleUserId",
          escalation_level AS "escalationLevel"
     FROM construction.maintenance_cases
    WHERE company_id = :companyId AND deleted_at IS NULL AND status <> 'CLOSED' AND warranty_deadline_at IS NOT NULL`, companyId, transaction);

/** Obras em garantia + o fim da garantia gravado no último project.warranty_started (ou a data do evento, para a conta pelo prazo configurado). */
const projectsInWarranty = (companyId, transaction) => select(
  `SELECT p.id AS "projectId", p.name, p.responsible_user_id AS "responsibleUserId",
          e.payload_json ->> 'warrantyEndsAt' AS "warrantyEndsAt", COALESCE(e.occurred_at, p.updated_at) AS "startedAt"
     FROM construction.projects p
     LEFT JOIN LATERAL (
       SELECT payload_json, occurred_at FROM integration.outbox_events o
        WHERE o.aggregate_id = p.id AND o.event_type = 'project.warranty_started'
        ORDER BY o.occurred_at DESC LIMIT 1) e ON true
    WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND p.status = 'WARRANTY'`, companyId, transaction);

module.exports = { openStages, openProjects, activeGuarantees, openWarrantyCases, projectsInWarranty };
