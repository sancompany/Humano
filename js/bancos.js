/**
 * SAN & CO. — js/bancos.js
 * Identidade visual por instituição.
 *
 * POR QUE ISTO EXISTE
 *   Três faturas em tons de amarelo obrigam a ler a legenda para saber qual
 *   é qual. Com a cor da marca, o reconhecimento é imediato — roxo é Nubank,
 *   laranja é Inter, e ninguém precisa conferir.
 *
 * As cores são ajustadas para fundo escuro: a marca original de vários bancos
 * é escura demais para ler sobre #121216. Bradesco e Santander são ambos
 * vermelhos na vida real, então aqui eles ficam em luminosidades bem
 * diferentes de propósito.
 *
 * Instituição desconhecida NUNCA cai em cinza genérico: recebe um tom fixo de
 * uma paleta reserva, escolhido pelo nome. O mesmo banco recebe sempre a
 * mesma cor, entre sessões e entre telas.
 */

const MARCAS = {
  'nubank':          '#A64BE8',
  'inter':           '#FF7A00',
  'banco inter':     '#FF7A00',
  'itau':            '#2E6BE6',
  'itaú':            '#2E6BE6',
  'itau empresas':   '#2E6BE6',
  'itaú empresas':   '#2E6BE6',
  'bradesco':        '#D62839',
  'santander':       '#FF5A5F',
  'banco do brasil': '#FFD400',
  'bb':              '#FFD400',
  'caixa':           '#0E86D4',
  'c6':              '#B0B4BC',
  'c6 bank':         '#B0B4BC',
  'btg':             '#0FA3B1',
  'btg pactual':     '#0FA3B1',
  'xp':              '#D9B310',
  'xp investimentos':'#D9B310',
  'binance':         '#F0B90B',
  'tesouro direto':  '#2A9D8F',
  'icatu':           '#7B4FE0',
  'kinea':           '#4A90D9',
  'sicoob':          '#00A67E',
  'safra':           '#8E9AAF',
  'original':        '#00A868',
  'pagbank':         '#39B54A',
  'mercado pago':    '#41C2F0'
};

/**
 * Código de compensação (BANKID no .OFX) para nome da instituição.
 * É o que permite dizer "Nubank" a partir de um arquivo que só traz "260".
 */
const CODIGOS = {
  '001': 'Banco do Brasil', '033': 'Santander',   '077': 'Inter',
  '104': 'Caixa',           '208': 'BTG Pactual', '212': 'Original',
  '237': 'Bradesco',        '260': 'Nubank',      '290': 'PagBank',
  '323': 'Mercado Pago',    '336': 'C6 Bank',     '341': 'Itaú',
  '380': 'PicPay',          '422': 'Safra',       '655': 'Neon',
  '748': 'Sicredi',         '756': 'Sicoob'
};

/**
 * Nome da instituição a partir do código de compensação.
 * @param {string} codigo BANKID do arquivo OFX
 * @returns {string|null} null quando o código não é conhecido
 */
export function bancoPorCodigo(codigo) {
  if (!codigo) return null;
  return CODIGOS[String(codigo).padStart(3, '0')] ?? null;
}

/** Tons de reserva, escolhidos para se distinguirem entre si no escuro. */
const RESERVA = [
  '#8B5CF6', '#3B82F6', '#F97316', '#10B981',
  '#EC4899', '#14B8A6', '#F59E0B', '#6366F1'
];

/** Soma estável dos caracteres — mesmo nome, mesma cor, sempre. */
function indiceEstavel(texto, total) {
  let soma = 0;
  for (let i = 0; i < texto.length; i += 1) soma = (soma + texto.charCodeAt(i) * (i + 1)) % 997;
  return soma % total;
}

/**
 * Cor de destaque de uma instituição.
 * @param {string} nome como aparece na tela ("Nubank", "Itaú Empresas")
 * @returns {string} hexadecimal
 */
export function corDoBanco(nome) {
  if (!nome) return RESERVA[0];

  const chave = String(nome)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // tira acento para casar "itau" com "Itaú"
    .trim();

  if (MARCAS[chave]) return MARCAS[chave];

  // casamento parcial: "Nubank Ultravioleta" ainda é roxo
  const parcial = Object.keys(MARCAS).find((marca) => chave.includes(marca));
  if (parcial) return MARCAS[parcial];

  return RESERVA[indiceEstavel(chave, RESERVA.length)];
}

/**
 * Versão translúcida da cor, para fundo de badge e trilho de barra.
 * @param {string} nome
 * @param {number} opacidade 0 a 1
 */
export function corDoBancoSuave(nome, opacidade = 0.16) {
  const hex = corDoBanco(nome).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacidade})`;
}
