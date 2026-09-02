/**
 * SAN & CO. — backend/services/driveVault.js
 * Garante que a estrutura de pastas do Data Vault existe no Drive —
 * idempotente: rodar isto 1 vez ou 100 vezes dá o mesmo resultado, nunca
 * cria pasta duplicada, porque sempre verifica se já existe antes de criar.
 *
 * A estrutura em si é a que foi fechada na conversa (mesclando a proposta
 * da Gemini com os ajustes discutidos): numeração fixa, uma pasta por
 * bloco do app. "05_PROJETOS" não tem subpastas fixas aqui — cada projeto
 * ganha a dele sob demanda, via garantirPastaProjeto(), não na estrutura
 * inicial (não faz sentido pré-criar pasta pra um cliente que ainda não
 * existe).
 */

import { google } from 'googleapis';
import { getClienteGoogle } from './googleAuth.js';

const NOME_RAIZ = 'SAN & CO. — DATA VAULT';

/** A árvore fixa — cada string é o nome exato da pasta no Drive. */
const ESTRUTURA = {
  '01_EXECUTIVO & DIRETORIA': [
    '01.1_Briefings_Matinais',
    '01.2_Planejamento_Estrategico'
  ],
  '02_FINANCEIRO & GATEWAYS': [
    '02.1_Asaas_Extratos_e_Relatorios',
    '02.2_Notas_Fiscais_e_Faturas',
    '02.3_Comprovantes_Pix_e_TED',
    '02.4_Reconciliacao_Noturna'
  ],
  '03_JURIDICO & CONTRATOS': [
    '03.1_Contratos_Assinados',
    '03.2_Termos_e_Politicas',
    '03.3_Documentos_Oficiais'
  ],
  '04_PANTEÃO — CONSELHO': [
    '04.1_Conversas_Arquivadas'
  ],
  '05_PROJETOS & CLIENTES (TENANTS)': [],   // subpastas nascem sob demanda, ver garantirPastaProjeto()
  '06_SISTEMA & AGENTES (STORAGE)': [
    '06.1_Manifestos_Index',
    '06.2_Audios_Raw_WhatsApp',
    '06.3_Logs_Auditoria'
  ]
};

/**
 * Acha uma pasta pelo nome, dentro de um pai específico — ou cria se não
 * existir. É esta função, chamada repetidamente, que torna tudo
 * idempotente: nunca cria sem antes checar.
 *
 * @param {string} nome
 * @param {string|null} idDoPai null = pasta raiz do "Meu Drive"
 * @returns {Promise<string>} o id da pasta (existente ou recém-criada)
 */
async function garantirPasta(nome, idDoPai = null) {
  const drive = google.drive({ version: 'v3', auth: getClienteGoogle() });

  const nomeEscapado = nome.replace(/'/g, "\\'");
  const restricaoPai = idDoPai ? `and '${idDoPai}' in parents` : "and 'root' in parents";
  const consulta = `name='${nomeEscapado}' and mimeType='application/vnd.google-apps.folder' `
                  + `and trashed=false ${restricaoPai}`;

  const { data } = await drive.files.list({ q: consulta, fields: 'files(id, name)', pageSize: 1 });

  if (data.files?.length) return data.files[0].id;

  const { data: nova } = await drive.files.create({
    requestBody: {
      name: nome,
      mimeType: 'application/vnd.google-apps.folder',
      ...(idDoPai ? { parents: [idDoPai] } : {})
    },
    fields: 'id'
  });

  return nova.id;
}

/**
 * Garante a árvore inteira, de uma vez. Devolve um mapa nome -> id, pra
 * quem chamar já saber onde salvar cada coisa sem precisar consultar de
 * novo (ex.: mapa['02.2_Notas_Fiscais_e_Faturas']).
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function garantirEstruturaCompleta() {
  const mapa = {};

  const idRaiz = await garantirPasta(NOME_RAIZ);
  mapa[NOME_RAIZ] = idRaiz;

  for (const [pastaNivel1, subpastas] of Object.entries(ESTRUTURA)) {
    const idNivel1 = await garantirPasta(pastaNivel1, idRaiz);
    mapa[pastaNivel1] = idNivel1;

    for (const subpasta of subpastas) {
      const idSub = await garantirPasta(subpasta, idNivel1);
      mapa[subpasta] = idSub;
    }
  }

  return mapa;
}

/**
 * Subpasta de ano/mês dentro de Notas Fiscais — criada sob demanda, não
 * na estrutura fixa (não faz sentido pré-criar os 12 meses de anos que
 * ainda nem chegaram).
 * @param {string} idPastaNotasFiscais o id de '02.2_Notas_Fiscais_e_Faturas'
 * @param {number} ano
 * @param {number} mes 1-12
 */
export async function garantirSubpastaAnoMes(idPastaNotasFiscais, ano, mes) {
  const NOMES_MES = ['01_Janeiro', '02_Fevereiro', '03_Março', '04_Abril', '05_Maio', '06_Junho',
                      '07_Julho', '08_Agosto', '09_Setembro', '10_Outubro', '11_Novembro', '12_Dezembro'];

  const idAno = await garantirPasta(String(ano), idPastaNotasFiscais);
  const idMes = await garantirPasta(NOMES_MES[mes - 1], idAno);
  return idMes;
}

/**
 * Pasta de um projeto/cliente, dentro de "05_PROJETOS & CLIENTES", com as
 * 3 subpastas padrão (Branding_e_Tokens, Financeiro, Documentos) — sob
 * demanda, na primeira vez que aquele projeto precisar salvar algo.
 * @param {string} idPastaProjetos o id de '05_PROJETOS & CLIENTES (TENANTS)'
 * @param {string} nomeProjeto
 */
export async function garantirPastaProjeto(idPastaProjetos, nomeProjeto) {
  const idProjeto = await garantirPasta(nomeProjeto, idPastaProjetos);

  const subpastas = {};
  for (const nome of ['Branding_e_Tokens', 'Financeiro', 'Documentos']) {
    subpastas[nome] = await garantirPasta(nome, idProjeto);
  }

  return { idProjeto, subpastas };
}
