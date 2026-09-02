/**
 * SAN & CO. — js/graficos.js
 * Desenho de gráfico em SVG puro — nenhuma dependência externa, seguindo a
 * mesma filosofia do resto do app ("sempre tudo sob controle, nada
 * externo"). Este arquivo só desenha; quem deriva os pontos é dados.js.
 *
 * POR QUE É UM ARQUIVO PRÓPRIO
 *   O gráfico de evolução aparece em dois lugares: o card resumido da
 *   Overview (financeiro.js) e a tela de detalhe dedicada (detalhe.js).
 *   financeiro.js já importa detalhe.js — se o gráfico morasse em
 *   financeiro.js, detalhe.js importar de volta criaria um ciclo. Um
 *   arquivo neutro, sem saber quem o consome, evita isso.
 */

const MESES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

/** '2026-08' -> 'ago/26' */
export function rotuloMesCurto(chave) {
  const [ano, mes] = chave.split('-').map(Number);
  return `${MESES_ABREV[mes - 1]}/${String(ano).slice(2)}`;
}

/**
 * Gráfico de área em SVG puro. Degradê verde se o saldo do período fechou
 * em alta, vermelho se em baixa — a cor carrega sinal, não é só estética.
 *
 * Sem dado suficiente (menos de 2 meses), devolve um estado vazio em vez de
 * um gráfico de dois pontos — dois pontos não é "evolução", é uma reta.
 *
 * @param {{ pontos: Array<{mes:string, saldo:number}>, absoluto: boolean, suficiente: boolean }} evolucao
 * @param {{ altura?: number }} opcoes altura em px do viewBox (largura é sempre 640, escala por CSS)
 */
export function svgEvolucaoSaldo({ pontos, absoluto, suficiente }, { altura = 200 } = {}) {
  if (!suficiente) {
    return `
      <div class="slot">
        <span class="slot__mark" aria-hidden="true"></span>
        <p class="slot__text">A evolução aparece a partir de 2 meses de movimentação importada.</p>
      </div>
    `;
  }

  const L = 640, A = altura, PAD_X = 8, PAD_Y = 14;
  const valores = pontos.map((p) => p.saldo);
  const min = Math.min(...valores, 0);
  const max = Math.max(...valores, 0);
  const amplitude = (max - min) || 1;

  const x = (i) => PAD_X + (i / (pontos.length - 1)) * (L - PAD_X * 2);
  const y = (v) => A - PAD_Y - ((v - min) / amplitude) * (A - PAD_Y * 2);

  const linha = pontos.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.saldo).toFixed(1)}`).join(' ');
  const area = `${linha} L ${x(pontos.length - 1).toFixed(1)} ${A} L ${x(0).toFixed(1)} ${A} Z`;

  const fechouPositivo = pontos.at(-1).saldo >= pontos[0].saldo;
  const corId = fechouPositivo ? 'evoPos' : 'evoNeg';
  const corLinha = fechouPositivo ? 'var(--success)' : 'var(--danger)';

  // um marcador a cada 3 meses evita poluir o eixo em telas estreitas
  const marcadores = pontos.map((p, i) => (
    i === 0 || i === pontos.length - 1 || i % 3 === 0
      ? `<text x="${x(i).toFixed(1)}" y="${A - 2}" class="grafico-evolucao__eixo">${rotuloMesCurto(p.mes)}</text>`
      : ''
  )).join('');

  return `
    <div class="grafico-evolucao" data-grafico-evolucao
         data-pontos='${JSON.stringify(pontos)}' data-absoluto="${absoluto}">
      <svg viewBox="0 0 ${L} ${A}" preserveAspectRatio="none" role="img"
           aria-label="Evolução do saldo nos últimos ${pontos.length} meses">
        <defs>
          <linearGradient id="${corId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${corLinha}" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="${corLinha}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#${corId})" stroke="none"/>
        <path d="${linha}" fill="none" stroke="${corLinha}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>
        ${marcadores}
      </svg>
    </div>
  `;
}
