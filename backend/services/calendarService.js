/**
 * SAN & CO. — backend/services/calendarService.js
 * Leitura da agenda principal ("primary" — a agenda padrão da conta
 * autorizada) e criação de compromissos.
 */

import { google } from 'googleapis';
import { getClienteGoogle } from './googleAuth.js';

/**
 * Próximos eventos a partir de agora.
 * @param {number} limite
 */
export async function listarProximosEventos(limite = 10) {
  const calendar = google.calendar({ version: 'v3', auth: getClienteGoogle() });

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults: limite,
    singleEvents: true,   // "desdobra" eventos recorrentes em ocorrências individuais
    orderBy: 'startTime'
  });

  return (data.items ?? []).map((evento) => ({
    id: evento.id,
    titulo: evento.summary ?? '(sem título)',
    inicio: evento.start?.dateTime ?? evento.start?.date,   // dateTime = com hora; date = dia inteiro
    fim: evento.end?.dateTime ?? evento.end?.date,
    diaInteiro: !evento.start?.dateTime,
    local: evento.location ?? null,
    link: evento.htmlLink
  }));
}

/**
 * Cria um compromisso na agenda principal.
 * @param {{ titulo: string, inicio: string, fim: string, local?: string, descricao?: string }} opcoes
 *   inicio/fim: string ISO 8601 (ex.: '2026-08-25T09:00:00-03:00')
 */
export async function criarEvento({ titulo, inicio, fim, local, descricao }) {
  const calendar = google.calendar({ version: 'v3', auth: getClienteGoogle() });

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: titulo,
      location: local,
      description: descricao,
      start: { dateTime: inicio },
      end: { dateTime: fim }
    }
  });

  return { id: data.id, link: data.htmlLink };
}
