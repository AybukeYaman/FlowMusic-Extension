// Term lists used by the local (non-LLM) brief parser and planner.
// Keys are canonical English terms written into prompts; aliases (including a
// few Turkish ones) map free text onto them.

export type Lexicon = Record<string, string[]>;

export const GENRES: Lexicon = {
  "lo-fi hip hop": ["lofi hip hop", "lo-fi hip hop", "lofi hiphop", "lofi", "lo-fi", "lo fi"],
  jazzhop: ["jazzhop", "jazz hop", "jazzy hip hop"],
  chillhop: ["chillhop", "chill hop"],
  jazz: ["jazz", "caz"],
  ambient: ["ambient", "ambiyans"],
  downtempo: ["downtempo"],
  "neo-soul": ["neo soul", "neo-soul"],
  "trip hop": ["trip hop", "trip-hop"],
  synthwave: ["synthwave", "retrowave"],
  chillwave: ["chillwave"],
  "dream pop": ["dream pop", "dreampop"],
  "bossa nova": ["bossa nova", "bossa"],
  "city pop": ["city pop"],
  classical: ["classical", "klasik"],
  cinematic: ["cinematic", "film score", "sinematik"],
  "solo piano": ["solo piano"],
  "acoustic folk": ["folk", "acoustic folk"],
  "deep house": ["deep house"],
  house: ["house music", "house"],
  "post-rock": ["post rock", "post-rock"],
  "new age": ["new age", "meditation music"],
  electronic: ["electronic", "elektronik"],
  "r&b": ["r&b", "rnb"],
  funk: ["funk"],
  blues: ["blues"],
};

export const MOODS: Lexicon = {
  calm: ["calm", "sakin*", "huzur*"],
  cozy: ["cozy", "cosy", "comfy", "rahat*"],
  warm: ["warm", "sıcak*"],
  melancholic: ["melancholic", "melancholy", "sad", "hüzün*", "melankoli*"],
  nostalgic: ["nostalgic", "nostalgia", "nostalji*"],
  dreamy: ["dreamy", "dreamlike", "rüya*"],
  peaceful: ["peaceful", "serene", "tranquil"],
  hopeful: ["hopeful", "optimistic", "umut*"],
  uplifting: ["uplifting", "bright", "happy", "neşe*"],
  mellow: ["mellow", "laid-back", "laid back", "relaxed", "chill"],
  introspective: ["introspective", "reflective", "thoughtful"],
  romantic: ["romantic", "romantik"],
  mysterious: ["mysterious", "gizemli"],
  dark: ["dark", "moody", "karanlık*"],
  focused: ["focused", "focus", "concentration", "odak*"],
  gentle: ["gentle", "soft", "yumuşak*"],
};

export const AMBIENCE: Lexicon = {
  "soft rain": ["rain", "rainy", "drizzle", "yağmur*"],
  "distant thunder": ["thunder", "storm", "gök gürültüsü"],
  "vinyl crackle": ["vinyl", "crackle", "record noise", "plak"],
  "café murmur": ["cafe", "café", "coffee shop", "coffee", "kahve*", "kafe*"],
  "ocean waves": ["ocean", "waves", "sea", "beach", "deniz*", "dalga*"],
  "forest birds": ["forest", "birds", "birdsong", "orman*", "kuş sesi*"],
  "crackling fireplace": ["fireplace", "fire", "şömine*"],
  "gentle wind": ["wind", "breeze", "rüzgar*"],
  "night city hum": ["city", "street", "urban", "şehir*", "şehr*"],
  "train rhythm": ["train", "railway", "tren*"],
  "page turns": ["library", "books", "kütüphane*"],
  "snowy stillness": ["snow", "winter", "karlı*", "kış*"],
  "night crickets": ["crickets", "summer night"],
  "flowing river": ["river", "stream", "nehir*", "nehr*"],
  "tape hiss": ["tape hiss", "cassette"],
};

export const INSTRUMENTS: Lexicon = {
  "Rhodes electric piano": ["rhodes", "electric piano", "e-piano", "wurlitzer"],
  "soft felt piano": ["felt piano"],
  piano: ["piano", "piyano*", "keys"],
  "nylon-string guitar": ["nylon guitar", "classical guitar", "nylon"],
  "clean electric guitar": ["electric guitar", "jazz guitar"],
  "acoustic guitar": ["acoustic guitar", "guitar", "gitar*"],
  "upright bass": ["upright bass", "double bass", "kontrbas"],
  "warm bass": ["bass", "bas"],
  saxophone: ["saxophone", "sax", "saksafon*"],
  "muted trumpet": ["trumpet", "trompet"],
  flute: ["flute", "flüt", "ney"],
  violin: ["violin", "keman*"],
  cello: ["cello", "çello", "viyolonsel"],
  "string ensemble": ["strings", "string section", "yaylılar"],
  "analog synth pad": ["synth", "synthesizer", "pad", "pads"],
  vibraphone: ["vibraphone", "vibes"],
  kalimba: ["kalimba"],
  harp: ["harp", "arp"],
  "music box": ["music box", "müzik kutusu"],
  "Hammond organ": ["organ", "hammond"],
  clarinet: ["clarinet", "klarnet"],
  koto: ["koto"],
  marimba: ["marimba"],
  "glockenspiel": ["glockenspiel", "bells"],
};

export const USES: Lexicon = {
  studying: ["study", "studying", "ders*", "çalışma*", "homework", "exam"],
  coding: ["coding", "programming", "kod"],
  "deep focus": ["focus", "deep work", "concentration", "odaklan*"],
  reading: ["reading", "kitap okuma", "okuma"],
  sleep: ["sleep", "sleeping", "bedtime", "uyku*"],
  relaxation: ["relax", "relaxation", "unwind", "rahatla*", "dinlen*"],
  meditation: ["meditation", "yoga", "mindfulness", "meditasyon*"],
  "working": ["work", "office", "iş"],
  gaming: ["gaming", "game", "oyun"],
};

export const TEXTURE_HINTS: Lexicon = {
  "warm tape saturation": ["tape", "analog", "analogue", "saturated"],
  "dusty sampled feel": ["dusty", "sampled", "boom bap", "boom-bap"],
  "airy spacious reverb": ["airy", "spacious", "reverb", "ethereal"],
  "muffled low-pass warmth": ["muffled", "lowpass", "low-pass", "underwater"],
  "crisp clean mix": ["crisp", "clean", "hi-fi", "polished"],
};

export const INSTRUMENTAL_ALIASES = [
  "instrumental", "no vocals", "no vocal", "without vocals", "no singing", "no lyrics",
  "vokalsiz", "enstrümantal", "sözsüz", "vokal olmasın",
];

export const AVOID_MARKERS = [
  "avoid", "without", "no", "not", "don't", "do not", "never",
  "olmasın", "istemiyorum", "olmadan", "yok",
];

// Pools used for variation axes, keyed by album energy.
export const RHYTHMS = {
  percussive: [
    "soft boom-bap groove with lazy swing",
    "brushed drums in a slow swing",
    "half-time groove with gentle rim clicks",
    "laid-back shuffle with muted kick",
    "minimal hi-hat pulse and soft kick",
    "lazy behind-the-beat drums",
    "light bossa-style percussion",
    "sparse finger-snap groove",
  ],
  // Used when the brief avoids drums/percussion or the album is very calm.
  nonPercussive: [
    "rubato phrasing with no percussion",
    "gentle pulse carried by the bass",
    "slow arpeggiated motion",
    "steady soft ostinato",
    "free-flowing sustained phrases",
    "lilting waltz-like sway",
  ],
} as const;

export const HARMONIES = [
  "warm major seventh chords",
  "soft minor ninth chords",
  "dorian-mode color",
  "suspended chords that resolve slowly",
  "slow ii-V-I movement",
  "lydian brightness",
  "add9 voicings with a descending bass line",
  "modal drone with gentle chord changes",
  "minor eleventh chords",
  "simple four-chord loop with jazzy extensions",
];

export const TEXTURES = [
  "warm tape saturation",
  "dusty sampled feel",
  "airy spacious reverb",
  "muffled low-pass warmth",
  "close-miked intimacy",
  "wide soft stereo field",
  "gentle wow and flutter",
  "rounded analog warmth",
];

export const ENERGY_LEVELS = {
  low: ["very calm", "calm and steady", "softly flowing"],
  medium: ["relaxed", "steady and warm", "gently moving"],
  high: ["upbeat", "driving", "bright and lively"],
} as const;

export const GENRE_PALETTES: Record<string, string[]> = {
  default: ["Rhodes electric piano", "piano", "nylon-string guitar", "warm bass", "analog synth pad", "vibraphone"],
  "lo-fi hip hop": ["Rhodes electric piano", "soft felt piano", "nylon-string guitar", "muted trumpet", "saxophone", "vibraphone", "kalimba", "analog synth pad", "flute"],
  jazzhop: ["Rhodes electric piano", "upright bass", "saxophone", "muted trumpet", "vibraphone", "clean electric guitar"],
  chillhop: ["Rhodes electric piano", "clean electric guitar", "flute", "warm bass", "vibraphone"],
  jazz: ["piano", "upright bass", "saxophone", "muted trumpet", "vibraphone", "clean electric guitar"],
  ambient: ["analog synth pad", "soft felt piano", "string ensemble", "glockenspiel", "harp", "cello"],
  classical: ["piano", "string ensemble", "cello", "violin", "harp", "flute", "clarinet"],
  cinematic: ["string ensemble", "piano", "cello", "harp", "analog synth pad"],
  "solo piano": ["piano", "soft felt piano"],
  "bossa nova": ["nylon-string guitar", "flute", "upright bass", "piano", "saxophone"],
  synthwave: ["analog synth pad", "clean electric guitar", "warm bass"],
  "new age": ["analog synth pad", "harp", "flute", "soft felt piano", "kalimba"],
  "acoustic folk": ["acoustic guitar", "nylon-string guitar", "cello", "violin", "harp"],
  "deep house": ["Rhodes electric piano", "analog synth pad", "warm bass"],
};

export const TEMPO_DEFAULTS: Record<string, [number, number]> = {
  default: [72, 90],
  "lo-fi hip hop": [70, 85],
  jazzhop: [80, 92],
  chillhop: [80, 95],
  jazz: [85, 120],
  ambient: [55, 75],
  "new age": [55, 72],
  classical: [60, 90],
  cinematic: [60, 90],
  "solo piano": [60, 85],
  "bossa nova": [110, 135],
  synthwave: [85, 110],
  "deep house": [118, 124],
  house: [120, 126],
  downtempo: [80, 100],
};
