import type { NormalizedAlbumBrief } from "../shared/types";
import type { Rng } from "./rng";
import { normalizeTitle } from "./uniqueness-validator";

// Theme vocabulary keyed by brief terms. Titles combine theme words with a
// shared generic pool through several patterns.
const THEME_NOUNS: Record<string, string[]> = {
  "soft rain": ["Rain", "Drizzle", "Puddles", "Umbrellas", "Raindrops", "Wet Pavement", "Window Glass"],
  "distant thunder": ["Thunder", "Storm Clouds", "Far Lightning"],
  "vinyl crackle": ["Vinyl", "Records", "Needle Drop", "B-Side"],
  "café murmur": ["Coffee", "Espresso", "Corner Café", "Steam", "Mugs"],
  "ocean waves": ["Tides", "Shoreline", "Seafoam", "Harbor", "Low Tide"],
  "forest birds": ["Pines", "Moss", "Birdsong", "Clearing", "Ferns"],
  "crackling fireplace": ["Embers", "Hearth", "Firelight", "Kindling"],
  "gentle wind": ["Breeze", "Kites", "Drift"],
  "night city hum": ["Streetlights", "Neon", "Rooftops", "Crosswalks", "Taxi Lights"],
  "train rhythm": ["Night Train", "Platforms", "Carriages", "Rails"],
  "page turns": ["Pages", "Bookshelves", "Margins", "Ink"],
  "snowy stillness": ["Snowfall", "Frost", "Wool", "Pale Light"],
  "night crickets": ["Fireflies", "Porch Lights", "Warm Nights"],
  "flowing river": ["Riverbank", "Currents", "Stepping Stones"],
  studying: ["Notebooks", "Margins", "Chapters", "Index Cards", "Late Study", "Desk Lamp"],
  coding: ["Terminal", "Commit", "Compile", "Syntax", "Cursor Blink"],
  "deep focus": ["Focus", "Flow State", "Quiet Hours"],
  reading: ["Paperbacks", "Bookmarks", "Reading Nook"],
  sleep: ["Lullaby", "Pillow", "Drowsy", "Dreams", "Moonlight"],
  meditation: ["Breath", "Stillness", "Lotus", "Incense"],
  nostalgic: ["Polaroids", "Old Letters", "Postcards", "Cassettes"],
  melancholic: ["Blue Hour", "Grey Skies", "Long Goodbye"],
  dreamy: ["Clouds", "Daydreams", "Haze"],
  cozy: ["Blankets", "Tea", "Slippers", "Warm Socks"],
  romantic: ["Letters", "Roses", "Slow Dance"],
};

const GENERIC_NOUNS = [
  "Window", "Kettle", "Lanterns", "Sundown", "Afterglow", "Echoes", "Static",
  "Paper Boats", "Honey", "Amber", "Velvet", "Daylight", "Evening", "Hallway",
  "Balcony", "Sunday", "Morning", "Rooftop", "Porch", "Garden", "Attic",
  "Postcard", "Compass", "Lighthouse", "Orchard", "Meadow", "Dusk", "Dawn",
  "Candle", "Blanket", "Teacup", "Notebook", "Bicycle", "Skyline", "Harbor",
  "Cardigan", "Sketchbook", "Radio", "Polaroid", "Overcast",
];

const ADJECTIVES = [
  "Faded", "Quiet", "Slow", "Soft", "Warm", "Golden", "Hazy", "Gentle",
  "Late", "Lazy", "Hushed", "Sleepy", "Pale", "Muted", "Silver", "Distant",
  "Little", "Lingering", "Velvet", "Mellow", "Drifting", "Low", "Amber", "Still",
];

const TIMES = ["3 AM", "Midnight", "Dusk", "Dawn", "Noon", "Sundown", "Night", "Twilight", "First Light"];
const PLACES = ["the Attic", "the Window", "the Kitchen", "the Library", "the Station", "the Garden", "Room 12", "the Rooftop", "the Corner Café"];

type Pattern = (rng: Rng, nouns: string[]) => string;

const PATTERNS: Pattern[] = [
  (rng, n) => `${rng.pick(ADJECTIVES)} ${rng.pick(n)}`,
  (rng, n) => `${rng.pick(n)} at ${rng.pick(TIMES)}`,
  (rng, n) => `${rng.pick(n)} & ${rng.pick(n)}`,
  (rng, n) => `${rng.pick(n)} in ${rng.pick(PLACES)}`,
  (rng, n) => `The ${rng.pick(ADJECTIVES)} ${rng.pick(n)}`,
  (rng, n) => `${rng.pick(ADJECTIVES)} ${rng.pick(n)}, ${rng.pick(TIMES)}`,
];

export function themeNouns(brief: NormalizedAlbumBrief): string[] {
  const keys = [...brief.ambience, ...brief.intendedUse, ...brief.moods];
  const themed = keys.flatMap((k) => THEME_NOUNS[k] ?? []);
  return [...new Set(themed)];
}

export class TitleGenerator {
  private readonly used = new Set<string>();
  private readonly nouns: string[];
  private readonly themed: string[];

  constructor(private readonly rng: Rng, brief: NormalizedAlbumBrief) {
    this.themed = themeNouns(brief);
    this.nouns = [...this.themed, ...GENERIC_NOUNS];
  }

  reserve(title: string): void {
    this.used.add(normalizeTitle(title));
  }

  next(): string {
    // Prefer theme words; mix in generic nouns for breadth.
    for (let attempt = 0; attempt < 200; attempt++) {
      const pool = this.themed.length > 0 && this.rng.next() < 0.6 ? this.themed : this.nouns;
      const pattern = PATTERNS[attempt < 100 ? this.rng.int(PATTERNS.length) : attempt % PATTERNS.length]!;
      const title = pattern(this.rng, pool);
      if (/(\b\w+\b).*\b\1\b/i.test(title)) continue; // "Rain & Rain"
      const key = normalizeTitle(title);
      if (!this.used.has(key)) {
        this.used.add(key);
        return title;
      }
    }
    // Exhaustive fallback keeps titles unique for very large albums.
    for (const adj of ADJECTIVES) {
      for (const noun of this.nouns) {
        for (const time of TIMES) {
          const title = `${adj} ${noun} at ${time}`;
          const key = normalizeTitle(title);
          if (!this.used.has(key)) {
            this.used.add(key);
            return title;
          }
        }
      }
    }
    throw new Error("title_space_exhausted");
  }
}

export function albumTitleFrom(rng: Rng, brief: NormalizedAlbumBrief): string {
  const nouns = themeNouns(brief);
  const noun = nouns.length > 0 ? rng.pick(nouns) : rng.pick(GENERIC_NOUNS);
  const forms = [`${noun} Sessions`, `${rng.pick(ADJECTIVES)} ${noun}`, `Faded Hours: ${noun}`];
  return rng.pick(forms);
}
