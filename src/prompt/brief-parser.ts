import type { Energy, NormalizedAlbumBrief } from "../shared/types";
import { FAMILIES, GENRE_FAMILY, USE_FAMILY } from "./families";
import {
  AMBIENCE, GENRES, INSTRUMENTAL_ALIASES, INSTRUMENTS, MOODS,
  TEXTURE_HINTS, USES, type Lexicon,
} from "./vocabulary";

// Deterministic keyword parser that turns one free-text album description
// into a structured brief. It is intentionally simple and does not pretend to
// understand language the way an LLM would; anything it cannot classify is
// still carried into prompts through `concept`.

const L = "\\p{L}\\p{N}";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An alias ending in "*" matches as a prefix (for suffixing languages such
// as Turkish: "piyano*" matches "piyanolu"); other aliases need whole words.
function aliasRegex(alias: string): RegExp {
  const prefix = alias.endsWith("*");
  const body = escapeRe(prefix ? alias.slice(0, -1) : alias).replace(/\s+/g, "[\\s-]+");
  return new RegExp(`(?<![${L}])${body}${prefix ? "" : `(?![${L}])`}`, "iu");
}

const regexCache = new Map<string, RegExp>();
function matches(text: string, alias: string): boolean {
  let re = regexCache.get(alias);
  if (!re) regexCache.set(alias, (re = aliasRegex(alias)));
  return re.test(text);
}

// Returns canonical keys in order of first appearance in the text.
export function matchLexicon(text: string, lexicon: Lexicon): string[] {
  const found: { key: string; pos: number }[] = [];
  for (const [key, aliases] of Object.entries(lexicon)) {
    let best = -1;
    for (const alias of aliases) {
      let re = regexCache.get(alias);
      if (!re) regexCache.set(alias, (re = aliasRegex(alias)));
      const m = re.exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best >= 0) found.push({ key, pos: best });
  }
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.key);
}

// Removes overlapping, more generic matches, e.g. "piano" when "soft felt
// piano" was matched by the same words, or "house" inside "deep house".
function dropSubsumed(keys: string[], lexicon: Lexicon, text: string): string[] {
  return keys.filter((k) => {
    const myAliases = lexicon[k] ?? [];
    return !keys.some((other) => {
      if (other === k) return false;
      const otherAliases = lexicon[other] ?? [];
      // `other` subsumes `k` if every alias of k that matches is contained in a matching alias of other.
      const mine = myAliases.filter((a) => matches(text, a));
      return mine.length > 0 && mine.every((a) =>
        otherAliases.some((o) => o !== a && o.replace("*", "").includes(a.replace("*", "")) && matches(text, o)),
      );
    });
  });
}

const AVOID_PATTERNS: RegExp[] = [
  // "Avoid: a, b and c." -> whole list up to sentence end
  /(?<![\p{L}])(?:avoid|exclude|excluding)\s*:?\s+([^.;!?\n]+)/giu,
  // "no vocals", "without drums", "never loud" -> up to a comma or sentence end
  /(?<![\p{L}])(?:no|without|never|not|don't want|do not (?:want|use|include))\s+([^,.;!?\n]+)/giu,
  // Turkish postfix negation: "vokal olmasın", "davul istemiyorum"
  /((?:[\p{L}-]+\s+){0,2}[\p{L}-]+)\s+(?:olmasın|olmasin|istemiyorum|olmadan)(?![\p{L}])/giu,
];

const LIST_SPLIT = /\s*(?:,|\/|\bor\b|\band\b|\bnor\b|\bve\b|\bveya\b)\s*/iu;
const LEADING_NOISE = /^(?:any|no|too|overly|very|the|a|an)\s+/iu;

export function extractAvoid(text: string): { terms: string[]; spans: [number, number][] } {
  const terms: string[] = [];
  const spans: [number, number][] = [];
  for (const pattern of AVOID_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const captured = m[1] ?? "";
      spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
      for (let part of captured.split(LIST_SPLIT)) {
        part = part.trim();
        while (LEADING_NOISE.test(part)) part = part.replace(LEADING_NOISE, "");
        part = part.replace(/\s+/g, " ").trim().toLowerCase();
        if (part.length < 2 || part.split(" ").length > 6) continue;
        if (!terms.includes(part)) terms.push(part);
      }
    }
  }
  return { terms, spans };
}

// Blanks negated phrases so "no piano" does not count as asking for piano.
// Same-length replacement keeps every other span index valid.
function blankSpans(text: string, spans: [number, number][]): string {
  let out = text;
  for (const [s, e] of spans) out = out.slice(0, s) + " ".repeat(e - s) + out.slice(e);
  return out;
}

function detectVariation(text: string): NormalizedAlbumBrief["variation"] {
  if (/\b(subtle|cohesive|consistent|similar|uniform|tutarlı|benzer)/iu.test(text)) return "subtle";
  if (/\b(diverse|varied|different|wide|eclectic|çeşitli|farklı)/iu.test(text)) return "wide";
  return "moderate";
}

function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/["“«]([^"”»]{3,60})["”»]/gu)) refs.add(m[1]!.trim());
  for (const m of text.matchAll(/(?:inspired by|in the style of|like|for my (?:channel|brand))\s+([^,.;\n]{3,60})/giu)) {
    refs.add(m[1]!.trim());
  }
  for (const m of text.matchAll(/(?:character|mascot|brand|channel|karakter|kanal)\s+(?:named|called|adlı|isimli)?\s*["“]?([\p{Lu}][\p{L}\s'-]{1,40})/gu)) {
    refs.add(m[1]!.trim());
  }
  return [...refs];
}

export function extractAlbumTitle(text: string): string | undefined {
  const m = text.match(/(?:album|albüm)\s+(?:called|titled|named|adı|ismi)\s*:?\s*["“']?([^"”'.,\n]{2,60})/iu);
  return m?.[1]?.trim();
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=[.!?])\s/u)[0] ?? flat;
  const trimmed = sentence.replace(/[.!?…\s]+$/u, "");
  return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}…` : trimmed;
}

// ------------------------------------------------------------- inference

const HIGH_ENERGY = /(?<![\p{L}])(energetic|upbeat|driving|dance|danceable|workout|hype|fast|lively|intense|party|epic|enerjik|hareketli|coşkulu)(?![\p{L}])/giu;
// Stems (sleep…, relax…) match word starts; whole words need a right
// boundary so "chill" does not fire inside "chillhop".
const LOW_ENERGY = /(?<![\p{L}])(sleep\p{L}*|meditat\p{L}*|relax\p{L}*|uyku\p{L}*|huzur\p{L}*|rahat\p{L}*|sakin\p{L}*|(?:calm|cozy|cosy|ambient|slow|gentle|peaceful|soft|quiet|mellow|chill|background|lofi|lo-fi|study|studying|yavaş|dinlendirici)(?![\p{L}]))/giu;
const LOW_USES = new Set(["studying", "sleep", "meditation", "relaxation", "reading", "deep focus", "coding"]);
const RESTFUL_USES = new Set(["sleep", "meditation"]);

function countMatches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => m[1]!.toLowerCase());
}

function inferEnergy(text: string, uses: string[], conflicts: string[]): Energy {
  const high = countMatches(HIGH_ENERGY, text);
  const low = countMatches(LOW_ENERGY, text);
  const restful = uses.find((u) => RESTFUL_USES.has(u));
  if (high.length > 0 && restful) {
    conflicts.push(`"${high[0]}" conflicts with ${restful} music; kept low energy for ${restful}.`);
    return "low";
  }
  if (high.length > 0 && low.length > 0) {
    // Conservative: the calmer reading of a mixed brief.
    conflicts.push(`Energy cues disagree ("${high[0]}" vs "${low[0]}"); using medium energy.`);
    return "medium";
  }
  if (high.length > 0) return "high";
  if (low.length > 0 || uses.some((u) => LOW_USES.has(u))) return "low";
  return "medium";
}

// Whole-word cues ("war" must not match "warm").
const FAMILY_KEYWORDS: [RegExp, string][] = [
  [/(?<![\p{L}])(piano|piyano)\s+(album|music|pieces|solos?|albümü?|müziği?|parçaları)(?![\p{L}])/iu, "piano"],
  [/(?<![\p{L}])(epic|battle|war|trailer|heroic|film score|orchestra|orchestral|savaş|epik)(?![\p{L}])/iu, "cinematic"],
  [/(?<![\p{L}])(campfire|folk|fingerstyle|banjo|kamp ateşi)(?![\p{L}])/iu, "acoustic"],
  [/(?<![\p{L}])(synth|synths|retro|neon|80s|1980s)(?![\p{L}])/iu, "electronic"],
  [/(?<![\p{L}])(brazil|brazilian|bossa|beach|seaside)(?![\p{L}])/iu, "bossa"],
];

function inferFamily(
  text: string, genres: string[], uses: string[], ambience: string[], inferences: string[],
): { family: string; secondary?: string } {
  const fromGenres = [...new Set(genres.map((g) => GENRE_FAMILY[g]).filter((f): f is string => !!f))];
  if (fromGenres.length > 0) {
    let secondary = fromGenres[1];
    if (!secondary && fromGenres[0] === "lofi" && ambience.includes("café murmur")) secondary = "jazz";
    return { family: fromGenres[0]!, secondary };
  }
  const keyword = FAMILY_KEYWORDS.find(([re]) => re.test(text));
  if (keyword) {
    inferences.push(`Genre family "${FAMILIES[keyword[1]]!.label}" inferred from the description.`);
    return { family: keyword[1] };
  }
  const use = uses.find((u) => USE_FAMILY[u]);
  if (use) {
    const family = USE_FAMILY[use]!;
    inferences.push(`Genre family "${FAMILIES[family]!.label}" inferred from the intended use (${use}).`);
    const secondary = family === "lofi" && ambience.includes("café murmur") ? "jazz" : undefined;
    return { family, secondary };
  }
  if (ambience.includes("café murmur")) {
    inferences.push(`Genre family "${FAMILIES.jazz!.label}" inferred from the café setting.`);
    return { family: "jazz" };
  }
  inferences.push(`No genre or use detected; defaulting to "${FAMILIES.lofi!.label}".`);
  return { family: "lofi" };
}

function inferTempo(text: string, family: string, energy: Energy, uses: string[], conflicts: string[]) {
  const range = text.match(/(\d{2,3})\s*(?:-|–|to|ile)\s*(\d{2,3})\s*bpm/iu);
  const single = text.match(/(\d{2,3})\s*bpm/iu);
  let tempo: { min: number; max: number; explicit: boolean };
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    tempo = { min: Math.min(a, b), max: Math.max(a, b), explicit: true };
  } else if (single) {
    const v = Number(single[1]);
    tempo = { min: Math.max(40, v - 3), max: v + 3, explicit: true };
  } else {
    const [min, max] = FAMILIES[family]!.tempo[energy];
    return { min, max, explicit: false };
  }
  const restful = uses.find((u) => RESTFUL_USES.has(u));
  if (restful && tempo.min > 100) {
    conflicts.push(`Requested ${tempo.min}–${tempo.max} BPM is fast for ${restful} music; kept the requested tempo.`);
  }
  return tempo;
}

const EVERY_TRACK = /(?<![\p{L}])(every (?:track|song)|all (?:the )?(?:tracks|songs)|each (?:track|song)|throughout|always|her parçada|her şarkıda|tüm parçalarda|hepsinde)/iu;

/** Ambience / instruments the user says must be in every track. */
function requiredEverywhere(positive: string, lexicon: Lexicon): string[] {
  const out = new Set<string>();
  for (const sentence of positive.split(/(?<=[.!?;\n])/u)) {
    if (!EVERY_TRACK.test(sentence)) continue;
    for (const key of matchLexicon(sentence, lexicon)) out.add(key);
  }
  return [...out];
}

const POSITIVE_VOCALS = /(?<![\p{L}])(vocals?|singing|singer|lyrics|choir|rap|vokal|şarkı sözü)(?![\p{L}])/iu;

export function parseBrief(description: string): NormalizedAlbumBrief {
  const text = description.normalize("NFC");
  const { terms: avoid, spans } = extractAvoid(text);
  const positive = blankSpans(text, spans);
  const inferences: string[] = [];
  const conflicts: string[] = [];

  const genres = dropSubsumed(matchLexicon(positive, GENRES), GENRES, positive);
  const mentioned = dropSubsumed(matchLexicon(positive, INSTRUMENTS), INSTRUMENTS, positive);
  const excludes = (term: string) => avoid.some((a) => term.toLowerCase().includes(a) || a.includes(term.toLowerCase()));
  // Explicit exclusions win over positive mentions.
  for (const i of mentioned.filter(excludes)) conflicts.push(`"${i}" is both requested and excluded; excluded it.`);
  const instruments = mentioned.filter((i) => !excludes(i));
  const ambienceMentioned = matchLexicon(positive, AMBIENCE);
  for (const a of ambienceMentioned.filter(excludes)) conflicts.push(`"${a}" is both requested and excluded; excluded it.`);
  const ambience = ambienceMentioned.filter((a) => !excludes(a));

  const intendedUse = matchLexicon(positive, USES);
  const avoidsVocals = avoid.some((a) => /vocal|sing|lyric|voice|vokal|söz/iu.test(a));
  const instrumentalOnly = avoidsVocals || INSTRUMENTAL_ALIASES.some((a) => matches(text, a));
  // Any vocal word left in the positive text after removing negated phrases.
  const positiveWithoutInstrumental = INSTRUMENTAL_ALIASES.reduce((t, a) => t.replace(aliasRegex(a), " "), positive);
  if (instrumentalOnly && POSITIVE_VOCALS.test(positiveWithoutInstrumental)) {
    conflicts.push("Vocals are mentioned but the album is instrumental-only; kept it instrumental.");
  }

  const energy = inferEnergy(positive, intendedUse, conflicts);
  const { family, secondary } = inferFamily(positive, genres, intendedUse, ambience, inferences);
  if (!genres.length && energy === "low" && countMatches(HIGH_ENERGY, positive).length === 0) {
    inferences.push("Low energy inferred from the brief.");
  }

  return {
    concept: firstSentence(text),
    family,
    secondaryFamily: secondary,
    genres,
    moods: matchLexicon(positive, MOODS),
    energy,
    ambience,
    instruments,
    requiredAmbience: requiredEverywhere(positive, AMBIENCE).filter((a) => ambience.includes(a)),
    requiredInstruments: requiredEverywhere(positive, INSTRUMENTS).filter((i) => instruments.includes(i)),
    tempo: inferTempo(positive, family, energy, intendedUse, conflicts),
    harmony: [],
    textures: matchLexicon(positive, TEXTURE_HINTS),
    intendedUse,
    instrumentalOnly,
    avoid,
    references: extractReferences(text),
    variation: detectVariation(positive),
    inferences,
    conflicts,
  };
}

/** "no drums" rules out all percussion. */
export function bansPercussion(brief: NormalizedAlbumBrief): boolean {
  return brief.avoid.some((a) =>
    /drum|percussion|beat|kick|snare|davul|perküsyon|ritim/iu.test(a) &&
    !/loud|heavy|harsh|hard|sharp|busy|aggressive|punchy|sert|yüksek/iu.test(a),
  );
}

/** "loud percussion" caps percussion at soft. */
export function capsPercussion(brief: NormalizedAlbumBrief): boolean {
  return brief.avoid.some((a) =>
    /drum|percussion|beat|kick|snare|davul|perküsyon/iu.test(a) &&
    /loud|heavy|harsh|hard|busy|aggressive|punchy|sert|yüksek/iu.test(a),
  );
}

const VOCAL_WORDS = /(?<![\p{L}])(vocal|vocals|voice|choir|singing|sung|rap)(?![\p{L}])/iu;

/** True if `phrase` would contradict the instrumental-only requirement. */
export function isVocal(phrase: string): boolean {
  return VOCAL_WORDS.test(phrase);
}

// An excluded category also excludes its members ("no strings" -> no cello).
const EXCLUSION_CATEGORIES: [RegExp, string[]][] = [
  [/strings?|yaylı/iu, ["string", "violin", "viola", "cello", "double bass", "bowed", "fiddle", "orchestra"]],
  [/drums?|percussion|davul|perküsyon/iu, ["drum", "kick", "snare", "hi-hat", "hats", "cymbal", "percussion", "taiko", "timpani", "shaker", "tambourine", "cajón", "rimshot", "pandeiro", "808", "brushes", "brushed snare", "finger snaps", "claps"]],
  [/brass/iu, ["brass", "trumpet", "horn", "trombone", "flugelhorn", "tuba", "fanfare"]],
  [/piano|piyano/iu, ["piano", "rhodes", "wurlitzer"]],
  [/guitars?|gitar/iu, ["guitar"]],
  [/synths?|synthesizers?/iu, ["synth"]],
  [/reverb/iu, ["reverb", "hall", "plate"]],
  [/rain|yağmur/iu, ["rain"]],
];

/** Words that an exclusion term rules out, including category members. */
export function exclusionWords(term: string): string[] {
  const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  // "loud percussion" restricts loudness, not every drum: categories apply to bare terms.
  const qualified = /loud|heavy|harsh|hard|sharp|busy|aggressive|punchy|sudden|distracting|sert|yüksek/iu.test(term);
  const members = qualified ? [] : EXCLUSION_CATEGORIES.filter(([re]) => re.test(term)).flatMap(([, m]) => m);
  return [...new Set([term.toLowerCase(), ...words, ...members])];
}

/**
 * The affirmative part of a phrase: "no drums; the pulse is carried by bass"
 * affirms only the bass. Negated clauses cannot contradict an exclusion.
 */
export function affirmativePart(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/(^|[;,.|]\s*)(no|without)\s+[^;,.|]*/gu, "$1");
}

// True if `phrase` would contradict anything in the avoid list.
export function conflictsWithAvoid(phrase: string, brief: NormalizedAlbumBrief): boolean {
  const p = affirmativePart(phrase);
  return brief.avoid.some((a) => exclusionWords(a).some((w) => p.includes(w)));
}
