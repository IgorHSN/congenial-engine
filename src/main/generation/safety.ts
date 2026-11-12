/**
 * Last-line guard that runs on every prompt before it reaches ComfyUI,
 * independent of which local LLM is configured: sexual content combined with
 * any indication of a minor is blocked. The refiner's system prompt carries the
 * same rule; this check catches models that ignore it and raw prompts.
 */

const SEXUAL_TERMS = [
  'nsfw',
  'nude',
  'nudity',
  'naked',
  'topless',
  'bottomless',
  'sex',
  'sexual',
  'sexy',
  'erotic',
  'porn',
  'hentai',
  'explicit',
  'rating_explicit',
  'rating_questionable',
  'lingerie',
  'nipples',
  'nipple',
  'areola',
  'breasts',
  'pussy',
  'vagina',
  'penis',
  'cock',
  'cum',
  'orgasm',
  'masturbat',
  'fellatio',
  'blowjob',
  'cunnilingus',
  'intercourse',
  'spread legs',
  'seductive',
  'suggestive',
  // pt-BR
  'nua',
  'nu ',
  'pelada',
  'pelado',
  'sexo',
  'transando',
  'transa',
  'erótic',
  'pornô',
  'putaria',
  'safada',
  'sensual',
];

const MINOR_TERMS = [
  'child',
  'children',
  'kid',
  'kids',
  'loli',
  'lolicon',
  'shota',
  'shotacon',
  'underage',
  'under age',
  'minor',
  'minors',
  'toddler',
  'infant',
  'preteen',
  'pre-teen',
  'prepubescent',
  'little girl',
  'little boy',
  'young girl',
  'young boy',
  'elementary school',
  'middle school',
  'grade schooler',
  // pt-BR
  'criança',
  'crianças',
  'crianca',
  'infantil',
  'menor de idade',
  'menores de idade',
  'pré-adolescente',
  'pre-adolescente',
  'novinha de',
];

const MINOR_AGE = /\b(?:[1-9]|1[0-7])\s*(?:yo|y\/o|y\.o\.|years?[\s-]*old|anos(?:\s+de\s+idade)?)\b/i;

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[_()[\]{}:,.;!?"']/g, ' ').replace(/\s+/g, ' ')} `;
}

function containsTerm(haystack: string, terms: string[]): string | null {
  for (const t of terms) {
    const needle = t.trim();
    // Prefix stems (e.g. "masturbat", "erótic") match word starts; others match whole words.
    const stem = needle.endsWith('at') || needle.endsWith('ic') || needle.endsWith('ót');
    const re = new RegExp(`(^|\\s)${escapeRe(needle)}${stem ? '' : '(?=\\s|$)'}`, 'i');
    if (re.test(haystack)) return needle;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSexual(text: string): boolean {
  return containsTerm(normalize(text), SEXUAL_TERMS) !== null;
}

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
}

/** Check all the texts of one request together (user text + refined prompts). */
export function checkSafety(...texts: string[]): SafetyVerdict {
  const joined = normalize(texts.join(' \n '));
  const sexual = containsTerm(joined, SEXUAL_TERMS);
  if (!sexual) return { allowed: true };
  const minor = containsTerm(joined, MINOR_TERMS) ?? (MINOR_AGE.test(joined) ? 'idade < 18' : null);
  if (minor) {
    return {
      allowed: false,
      reason: 'Pedido bloqueado: conteúdo sexual/sugestivo combinado com indicação de menor de idade. Todos os personagens precisam ser adultos.',
    };
  }
  return { allowed: true };
}
