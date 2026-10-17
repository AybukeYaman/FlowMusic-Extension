import type { Energy } from "../shared/types";

// Genre families: coherent option pools for every musical dimension. A track
// draws all of its decisions from its album's family (plus, lightly, an
// optional second family), so variety never wanders into unrelated genres.
// Influences describe eras and styles only, never artist names.

export type Level = "none" | "soft" | "medium" | "strong";

export interface Leveled {
  text: string;
  level: Level;
}

export interface Family {
  id: string;
  label: string;
  subgenres: string[];
  influences: string[];
  leads: string[];
  supports: string[];
  bass: string[];
  percussion: Leveled[];
  grooves: Leveled[];
  tempo: Record<Energy, [number, number]>;
  keys: string[];
  harmony: string[];
  melody: string[];
  arrangement: string[];
  ambience: string[];
  production: string[];
  space: string[];
  dynamics: Record<Energy, string[]>;
  moodShades: Record<Energy, string[]>;
}

const KEYS_ALL = [
  "D minor", "F major", "A minor", "E-flat major", "G minor", "B-flat major",
  "C minor", "A-flat major", "E minor", "D-flat major", "G major", "F minor",
];

export const FAMILIES: Record<string, Family> = {
  lofi: {
    id: "lofi",
    label: "lo-fi / jazzhop",
    subgenres: ["lo-fi hip hop", "jazzhop", "chillhop", "lo-fi soul", "dusty beat-tape lo-fi"],
    influences: [
      "late-1990s boom-bap beat tapes", "early-2000s Japanese jazzhop", "1970s soul and electric-piano balladry",
      "2010s bedroom tape-loop lo-fi", "classic hard-bop chord voicings", "vintage cassette four-track demos",
    ],
    leads: [
      "Rhodes electric piano", "soft felt piano", "nylon-string guitar", "muted trumpet", "tenor saxophone",
      "vibraphone", "Wurlitzer electric piano", "clean jazz guitar", "kalimba", "flute",
    ],
    supports: [
      "warm analog synth pad", "soft organ chords", "glockenspiel accents", "muted jazz guitar comping",
      "celesta sparkles", "vinyl-sampled string swells", "Rhodes electric piano chords", "nylon-string guitar arpeggios",
      "vibraphone accents", "soft felt piano chords",
    ],
    bass: [
      "round upright bass with gentle slides", "warm electric bass with a soft fingered tone",
      "quiet sub-heavy sine bass with rounded attacks", "muted electric bass playing simple roots and fifths",
      "relaxed walking upright bass",
    ],
    percussion: [
      { text: "no drums; the pulse is carried by bass and keys", level: "none" },
      { text: "dusty boom-bap kit with a soft kick and brushed snare", level: "soft" },
      { text: "lazy lo-fi drums with muted rimshots and closed hi-hats", level: "soft" },
      { text: "quiet kick, brushed snare and tape-wobbled hats", level: "soft" },
      { text: "finger snaps, shaker and a soft kick", level: "soft" },
      { text: "crisp boom-bap kit with a slightly punchy snare", level: "medium" },
      { text: "head-nod drums with swung hats and side-stick", level: "medium" },
    ],
    grooves: [
      { text: "lazy behind-the-beat swing", level: "soft" },
      { text: "half-time head-nod feel", level: "soft" },
      { text: "loose triplet swing with late snares", level: "soft" },
      { text: "relaxed pocket with a light 55% swing", level: "soft" },
      { text: "laid-back shuffle", level: "medium" },
      { text: "head-nod groove with ghost notes", level: "medium" },
    ],
    tempo: { low: [65, 80], medium: [75, 92], high: [88, 100] },
    keys: KEYS_ALL,
    harmony: [
      "warm major-seventh chords with added ninths", "minor-ninth vamp over a two-chord loop",
      "ii–V–I movement with chromatic passing chords", "Dorian minor with suspended voicings",
      "descending bass line under add9 chords", "a borrowed iv chord for a bittersweet turn",
      "slow four-chord loop with extended voicings", "minor-eleventh chords that never fully resolve",
    ],
    melody: [
      "a short four-note motif repeated with small rhythmic changes", "sparse phrases that leave long gaps",
      "call-and-response between the lead and the support", "a stepwise melody that resolves only in the last bar",
      "pentatonic phrases placed slightly behind the beat", "a hummable theme stated twice, then left to the chords",
    ],
    arrangement: [
      "intro on keys alone, drums enter at bar 9, a short filtered breakdown midway, gentle fade-out",
      "starts on the main loop, adds a counter-melody in the second half, ends on a held chord",
      "two contrasting sections with a stripped-back bridge, returning to the theme at the end",
      "loop-based form that slowly adds layers and removes them again for the outro",
      "cold start on the full beat, a quiet middle with only bass and keys, tape-stop ending",
    ],
    ambience: [
      "soft rain", "vinyl crackle", "café murmur", "night city hum", "page turns",
      "gentle wind", "clock ticking in a quiet room", "night crickets",
    ],
    production: [
      "warm tape saturation with slight wow and flutter", "dusty sampled feel with low-passed highs",
      "clean but warm mix with gentle bus compression", "cassette-style noise floor and rounded transients",
      "bit-reduced drums under clean, warm keys",
    ],
    space: [
      "short room reverb, narrow and center-focused", "wide stereo keys over a mono-centered bass",
      "small plate reverb on the lead only", "close, dry mix with light stereo chorus on the pads",
    ],
    dynamics: {
      low: ["steady, even dynamics with no sudden peaks", "soft dynamics that swell only slightly at section changes"],
      medium: ["a gentle build in the second half that never gets loud", "moderate dynamics with a soft drop before the last section"],
      high: ["punchy but controlled dynamics", "a clear lift into the final section"],
    },
    moodShades: {
      low: ["quiet and introspective", "nostalgic and warm", "softly hopeful", "sleepy and content", "bittersweet late-night calm"],
      medium: ["easygoing and warm", "lightly upbeat", "sunny and relaxed"],
      high: ["bright and bouncy", "confident head-nod energy"],
    },
  },

  jazz: {
    id: "jazz",
    label: "café jazz",
    subgenres: ["café jazz trio", "cool jazz ballad", "late-night lounge jazz", "modal jazz piece"],
    influences: [
      "late-1950s cool jazz", "early-1960s hard-bop records", "1960s modal jazz",
      "smoky 1950s lounge recordings", "Scandinavian chamber jazz",
    ],
    leads: ["acoustic piano", "tenor saxophone", "muted trumpet", "vibraphone", "hollow-body jazz guitar", "flugelhorn", "clarinet"],
    supports: ["piano comping", "guitar comping", "soft Hammond organ pads", "flute counter-lines", "string section pad", "vibraphone chords"],
    bass: ["upright bass walking at a relaxed pace", "upright bass in a long-note two-feel", "bowed upright bass on long tones"],
    percussion: [
      { text: "no drums; bass and piano keep time", level: "none" },
      { text: "brushes on snare with a feathered kick", level: "soft" },
      { text: "light ride cymbal and brushes", level: "soft" },
      { text: "swinging ride cymbal with crisp hi-hat on 2 and 4", level: "medium" },
    ],
    grooves: [
      { text: "slow ballad tempo with a rubato intro", level: "soft" },
      { text: "gentle swing in two-feel", level: "soft" },
      { text: "medium swing", level: "medium" },
      { text: "relaxed straight eighths with a bossa tinge", level: "soft" },
    ],
    tempo: { low: [60, 85], medium: [90, 130], high: [130, 170] },
    keys: KEYS_ALL,
    harmony: [
      "rich ii–V–I chains with altered dominants", "a modal vamp in Dorian", "ballad changes with tritone substitutions",
      "quartal voicings over a pedal bass", "blues form with jazzy extensions",
    ],
    melody: [
      "a lyrical theme stated by the lead, then one short improvised chorus", "breathy phrases with long held notes",
      "question-and-answer phrases between the lead and the piano", "a motif developed through small sequences",
    ],
    arrangement: [
      "head, one short solo, head out with a soft ending", "rubato intro, in-tempo theme, gentle ritardando ending",
      "piano intro, theme, a brief bass break, theme again",
    ],
    ambience: ["café murmur", "clinking cups", "soft rain", "small-club room tone"],
    production: [
      "warm, natural live-room recording", "vintage 1960s studio warmth with light tape hiss", "close-miked, intimate trio recording",
    ],
    space: ["natural small-room reverb", "wide stereo trio placement", "near-mono vintage image with a short plate"],
    dynamics: {
      low: ["hushed dynamics, brushes kept light", "soft, conversational dynamics"],
      medium: ["natural ebb and flow between soloists", "a modest swell during the solo"],
      high: ["lively dynamics with crisp accents", "a confident climax before the final head"],
    },
    moodShades: {
      low: ["smoky and intimate", "late-night and reflective", "warm and unhurried"],
      medium: ["elegant and relaxed", "quietly playful"],
      high: ["spirited and bright", "swinging and confident"],
    },
  },

  bossa: {
    id: "bossa",
    label: "bossa nova",
    subgenres: ["bossa nova", "samba-jazz ballad", "Brazilian lounge"],
    influences: ["late-1950s Rio bossa nova", "1960s samba-jazz records", "1970s Brazilian studio arrangements"],
    leads: ["nylon-string guitar", "flute", "soft acoustic piano", "vibraphone", "muted trumpet"],
    supports: ["light string pad", "Rhodes electric piano chords", "soft woodwind section", "celesta accents", "nylon-string guitar comping"],
    bass: ["upright bass in a gentle two-feel", "soft electric bass on a root-fifth bossa pattern"],
    percussion: [
      { text: "no drums; guitar comping carries the bossa rhythm", level: "none" },
      { text: "brushed cross-stick bossa pattern with shaker", level: "soft" },
      { text: "light pandeiro and shaker", level: "soft" },
    ],
    grooves: [
      { text: "classic bossa nova syncopation", level: "soft" },
      { text: "slow samba-canção sway", level: "soft" },
      { text: "lilting samba-jazz pulse", level: "medium" },
    ],
    tempo: { low: [100, 118], medium: [115, 135], high: [130, 150] },
    keys: KEYS_ALL,
    harmony: [
      "major-seventh chords with chromatic inner voices", "minor ii–V turns into a bright major chorus",
      "diminished passing chords between diatonic changes", "a gentle descending chromatic line under sustained chords",
    ],
    melody: [
      "a soft, conversational melody with syncopated phrasing", "long, floating notes over busy guitar comping",
      "a theme passed between flute and guitar",
    ],
    arrangement: [
      "guitar intro, theme, a short instrumental bridge, theme with a soft fade",
      "theme stated quietly, repeated with fuller strings, ends on a suspended chord",
    ],
    ambience: ["café murmur", "gentle wind", "soft rain", "distant ocean waves"],
    production: ["warm, airy studio recording", "vintage 1960s warmth with light tape hiss", "intimate, close-miked guitar-led mix"],
    space: ["light plate reverb, wide strings", "natural room sound, guitar centered"],
    dynamics: {
      low: ["whisper-soft dynamics throughout", "gentle, even dynamics"],
      medium: ["a soft lift when the strings enter", "breathing dynamics between sections"],
      high: ["brighter, rhythmic dynamics", "a lively final chorus"],
    },
    moodShades: {
      low: ["sun-warmed and dreamy", "softly nostalgic"],
      medium: ["breezy and elegant", "sunny and relaxed"],
      high: ["bright and carefree", "playful and sunny"],
    },
  },

  ambient: {
    id: "ambient",
    label: "ambient",
    subgenres: ["ambient", "drone ambient", "new age", "ambient electronica"],
    influences: [
      "late-1970s ambient tape music", "1990s chill-out room ambient", "1980s Japanese environmental music", "minimalist process music",
    ],
    leads: ["soft felt piano", "analog synth pad", "glassy bell synth", "bowed cello", "harp", "kalimba", "processed guitar swells"],
    supports: ["long evolving pad", "granular texture layer", "low sub drone", "bowed string drone", "music box", "soft choir-like synth pad"],
    bass: ["deep sub drone", "slow-moving synth bass notes", "no distinct bass, only a low pad register"],
    percussion: [
      { text: "no percussion", level: "none" },
      { text: "no drums; slow pulses come from pad swells", level: "none" },
      { text: "very soft mallet pulses", level: "soft" },
      { text: "a distant hand-drum heartbeat", level: "soft" },
    ],
    grooves: [
      { text: "free time with no fixed meter", level: "none" },
      { text: "slow pulsing swells every few bars", level: "none" },
      { text: "gentle repeating arpeggio pulse", level: "soft" },
    ],
    tempo: { low: [50, 70], medium: [60, 85], high: [80, 100] },
    keys: KEYS_ALL,
    harmony: [
      "slowly shifting suspended chords", "a Lydian drone with gentle colour changes",
      "a two-chord sway between I and IV", "a static modal drone with overtones",
    ],
    melody: [
      "very sparse notes with long decays", "no clear melody; motifs surface from the texture",
      "slow descending phrases repeated an octave apart",
    ],
    arrangement: [
      "slow fade-in, a long sustained middle, slow fade-out", "layers added one by one, then removed in reverse order",
      "a single evolving texture with one gentle peak",
    ],
    ambience: ["distant ocean waves", "soft rain", "forest birds", "gentle wind", "flowing river", "snowy stillness"],
    production: ["clean hi-fi mix with soft saturation", "lush tape-delay textures", "airy mix with lots of headroom"],
    space: ["huge hall reverb with a long tail", "wide, immersive stereo field", "slow stereo panning movement"],
    dynamics: {
      low: ["almost static dynamics, nothing louder than a whisper", "very slow swells over minutes"],
      medium: ["slow swells with one gentle peak", "soft, breathing dynamics"],
      high: ["a broad, rising swell", "bright, expansive dynamics"],
    },
    moodShades: {
      low: ["weightless and calm", "still and meditative", "softly drifting"],
      medium: ["open and luminous", "quietly uplifting"],
      high: ["vast and radiant", "expansive and bright"],
    },
  },

  piano: {
    id: "piano",
    label: "solo / neo-classical piano",
    subgenres: ["solo piano", "neo-classical piano", "minimal piano"],
    influences: ["early-1900s French impressionism", "contemporary neo-classical piano", "1970s minimalist piano", "Romantic-era nocturnes"],
    leads: ["soft felt piano", "upright piano", "grand piano"],
    supports: ["string quartet pad", "solo cello", "soft synth pad", "celesta", "solo violin"],
    bass: ["low left-hand piano register", "cello on low sustained notes", "no separate bass instrument"],
    percussion: [{ text: "no percussion", level: "none" }],
    grooves: [
      { text: "rubato, breathing tempo", level: "none" },
      { text: "steady, gentle pulse in 3/4", level: "none" },
      { text: "flowing arpeggiated eighths", level: "none" },
    ],
    tempo: { low: [55, 75], medium: [70, 95], high: [90, 120] },
    keys: KEYS_ALL,
    harmony: [
      "impressionist extended chords", "a simple diatonic progression with suspensions",
      "minor key that turns to its relative major", "modal mixture with soft surprises",
    ],
    melody: [
      "a singing right-hand melody over broken chords", "a short motif echoed in different registers",
      "a melody that rises slowly and settles back",
    ],
    arrangement: [
      "theme, variation, quiet return", "AABA form with a soft bridge",
      "a slow build to a gentle climax, then a quiet coda",
    ],
    ambience: ["soft room tone and pedal noise", "soft rain", "crackling fireplace", "clock ticking in a quiet room"],
    production: [
      "close-miked felt piano with audible hammer noise", "natural concert-hall recording", "intimate home-recording warmth",
    ],
    space: ["natural hall reverb", "close and dry, very intimate", "medium room with a soft tail"],
    dynamics: {
      low: ["pianissimo throughout", "soft dynamics with tender rubato"],
      medium: ["expressive dynamics with a modest climax", "natural swells following the phrases"],
      high: ["wide dynamics with a strong climax", "passionate forte passages"],
    },
    moodShades: {
      low: ["tender and reflective", "quiet and wistful", "peaceful and still"],
      medium: ["hopeful and gentle", "warm and nostalgic"],
      high: ["dramatic and soaring", "passionate and bright"],
    },
  },

  cinematic: {
    id: "cinematic",
    label: "cinematic orchestral",
    subgenres: ["cinematic orchestral", "emotional film score", "fantasy adventure score", "epic trailer score"],
    influences: ["1980s adventure film scores", "modern hybrid trailer music", "late-Romantic orchestral writing", "1970s war-film marches"],
    leads: ["French horn section", "solo violin", "string ensemble", "solo cello", "piano", "trumpet", "solo oboe"],
    supports: ["low brass", "harp arpeggios", "celesta", "synth drone", "woodwind section", "choir"],
    bass: ["double basses with low brass", "cello and bass ostinato", "deep sub hits under the orchestra"],
    percussion: [
      { text: "no percussion", level: "none" },
      { text: "light timpani", level: "soft" },
      { text: "timpani rolls and soft cymbals", level: "medium" },
      { text: "taiko and orchestral drums", level: "strong" },
      { text: "marching snare with bass drum", level: "strong" },
    ],
    grooves: [
      { text: "rubato build", level: "none" },
      { text: "steady march", level: "medium" },
      { text: "driving ostinato", level: "strong" },
    ],
    tempo: { low: [60, 80], medium: [80, 110], high: [110, 150] },
    keys: KEYS_ALL,
    harmony: [
      "minor key with heroic major lifts", "modal mixture with a Phrygian edge",
      "slow chorale progression", "pedal-point tension resolving to major",
    ],
    melody: [
      "a noble theme stated by horns, answered by strings", "a short heroic motif developed through the track",
      "a lyrical solo line over sustained strings",
    ],
    arrangement: [
      "quiet opening, gradual build, full climax, short resolution",
      "theme, development with rising tension, a final restatement",
      "ostinato build with layered entries and an abrupt stop",
    ],
    ambience: ["gentle wind", "distant thunder", "snowy stillness"],
    production: ["polished modern film-score mix", "warm analog orchestral recording", "hybrid orchestra with subtle synths"],
    space: ["large scoring-stage reverb", "wide orchestral stereo image"],
    dynamics: {
      low: ["restrained dynamics with a soft peak", "quiet, sustained dynamics"],
      medium: ["a measured build to a moderate climax", "breathing dynamics between sections"],
      high: ["huge dynamic range with an epic climax", "relentless build to a powerful peak"],
    },
    moodShades: {
      low: ["melancholic and noble", "quietly emotional"],
      medium: ["adventurous and hopeful", "tense but warm"],
      high: ["epic and triumphant", "intense and heroic"],
    },
  },

  acoustic: {
    id: "acoustic",
    label: "acoustic folk",
    subgenres: ["acoustic folk", "instrumental indie folk", "fingerstyle acoustic"],
    influences: ["1970s British folk", "2000s indie-folk home recordings", "American fingerstyle guitar tradition"],
    leads: ["fingerpicked steel-string guitar", "nylon-string guitar", "mandolin", "fiddle", "soft piano"],
    supports: ["cello", "pump organ", "harmonica", "light strings", "second acoustic guitar"],
    bass: ["upright bass", "soft electric bass", "no bass; low guitar strings carry the bottom end"],
    percussion: [
      { text: "no percussion", level: "none" },
      { text: "brushed cajón", level: "soft" },
      { text: "light tambourine and distant foot stomps", level: "soft" },
    ],
    grooves: [
      { text: "gentle waltz", level: "soft" },
      { text: "fingerpicked Travis pattern", level: "soft" },
      { text: "slow, open strumming", level: "soft" },
    ],
    tempo: { low: [70, 90], medium: [90, 115], high: [115, 135] },
    keys: KEYS_ALL,
    harmony: ["open-string chords with drones", "simple I–IV–V with suspended colours", "modal folk progression in Mixolydian"],
    melody: ["a simple, singable melody", "melody woven into the fingerpicking", "a short motif that returns between sections"],
    arrangement: ["solo guitar intro, cello joins, quiet ending", "verse-like sections with an instrumental chorus", "theme, quiet bridge, fuller final theme"],
    ambience: ["crackling fireplace", "forest birds", "gentle wind", "soft rain"],
    production: ["warm, natural room recording", "intimate home-studio feel with finger noise", "clean, airy acoustic mix"],
    space: ["natural wooden-room reverb", "close and dry"],
    dynamics: {
      low: ["soft, even dynamics", "gentle dynamics with natural breathing"],
      medium: ["a gentle lift in the final section", "natural, expressive dynamics"],
      high: ["driving, energetic strumming dynamics", "a full, bright finale"],
    },
    moodShades: {
      low: ["homely and calm", "wistful and warm"],
      medium: ["warm and hopeful", "open-hearted"],
      high: ["bright and lively", "joyful and rustic"],
    },
  },

  electronic: {
    id: "electronic",
    label: "electronic chill",
    subgenres: ["downtempo", "chillwave", "synthwave", "chill deep house"],
    influences: ["1980s analog synth soundtracks", "late-1990s downtempo", "2010s chillwave", "early-2000s chill-out compilations"],
    leads: ["analog synth lead", "arpeggiated synth", "Rhodes electric piano", "clean electric guitar", "plucked synth"],
    supports: ["warm pad", "vocoder-free synth choir", "filtered chord stabs", "tape-delayed guitar", "bell synth"],
    bass: ["rounded analog synth bass", "deep sub bass", "plucky sequenced bass"],
    percussion: [
      { text: "no drums; the arpeggio carries the rhythm", level: "none" },
      { text: "soft drum machine with gentle claps", level: "soft" },
      { text: "808 kick and shaker", level: "medium" },
      { text: "four-on-the-floor kick with crisp hats", level: "strong" },
    ],
    grooves: [
      { text: "half-time trip-hop sway", level: "soft" },
      { text: "steady sixteenth-note arpeggio drive", level: "medium" },
      { text: "four-on-the-floor pulse", level: "strong" },
    ],
    tempo: { low: [80, 95], medium: [95, 118], high: [118, 128] },
    keys: KEYS_ALL,
    harmony: ["lush minor-seventh progressions", "major chords with sus2 colours", "a simple minor loop with a lifting bridge"],
    melody: ["a short synth hook", "arpeggiated motif that evolves slowly", "a soaring lead line in the last section"],
    arrangement: ["filtered intro, full groove, breakdown, final drop", "slow build with layered synths, soft outro", "loop-based with gradual filter sweeps"],
    ambience: ["night city hum", "distant ocean waves", "gentle wind"],
    production: ["warm analog synth character", "glossy modern mix with sidechain breathing", "retro tape-saturated synths"],
    space: ["wide stereo synths with long delays", "big plate reverb on pads"],
    dynamics: {
      low: ["smooth, even dynamics", "soft sidechain breathing only"],
      medium: ["gentle builds into each section", "moderate filter-driven dynamics"],
      high: ["energetic builds and drops", "punchy, driving dynamics"],
    },
    moodShades: {
      low: ["nocturnal and dreamy", "hazy and calm"],
      medium: ["nostalgic and glowing", "smooth and confident"],
      high: ["euphoric and bright", "driving and neon-lit"],
    },
  },
};

/** Canonical genre keys (vocabulary.GENRES) -> family. */
export const GENRE_FAMILY: Record<string, string> = {
  "lo-fi hip hop": "lofi", jazzhop: "lofi", chillhop: "lofi", "neo-soul": "lofi", "r&b": "lofi", funk: "lofi",
  "city pop": "electronic", jazz: "jazz", blues: "jazz", "bossa nova": "bossa",
  ambient: "ambient", "new age": "ambient", classical: "piano", "solo piano": "piano",
  cinematic: "cinematic", "post-rock": "cinematic", "acoustic folk": "acoustic",
  synthwave: "electronic", chillwave: "electronic", electronic: "electronic", "deep house": "electronic",
  house: "electronic", downtempo: "electronic", "trip hop": "electronic", "dream pop": "electronic",
};

/** Intended use -> family used when no genre is stated. */
export const USE_FAMILY: Record<string, string> = {
  studying: "lofi", coding: "lofi", "deep focus": "lofi", reading: "lofi", working: "lofi",
  sleep: "ambient", meditation: "ambient", relaxation: "ambient", gaming: "electronic",
};

/** Listening-context phrases per intended use. */
export const USE_CONTEXT: Record<string, string[]> = {
  studying: [
    "for long study sessions; stays in the background without pulling attention",
    "for focused late-night studying; steady and unobtrusive",
    "for reading and note-taking; nothing that interrupts concentration",
  ],
  coding: ["for coding sessions; steady, repetitive and non-distracting", "for deep work at a desk; even and predictable"],
  "deep focus": ["for deep focus; minimal surprises", "for concentrated work; even energy throughout"],
  reading: ["for quiet reading; soft and unobtrusive", "for reading in a cozy corner"],
  working: ["for working at a desk; pleasant background", "for a calm workday"],
  sleep: ["for falling asleep; nothing that could wake the listener", "for winding down at bedtime"],
  relaxation: ["for unwinding after a long day", "for relaxing on the couch"],
  meditation: ["for meditation; steady and spacious", "for slow breathing and stillness"],
  gaming: ["for relaxed gaming sessions", "as background for exploring a game world"],
};

export const DEFAULT_CONTEXT = ["for relaxed listening", "as calm background music", "for a quiet evening"];
