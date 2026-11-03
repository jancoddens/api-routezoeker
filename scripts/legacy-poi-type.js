'use strict';

// Bepaalt het POI-type (Gebouwen / Locaties / Wandelnetwerken) voor een punt
// van de oude site. Is het Type-veld daar ingevuld, dan wint dat altijd.
// Was het leeg (37 punten op de oude site), dan beslissen trefwoorden in de
// titel/ondertitel: bouwwerken -> Gebouwen, wandelnetwerk -> Wandelnetwerken,
// al de rest (natuur, parken, bossen, ...) -> Locaties.

const POI_TYPES = ['Gebouwen', 'Locaties', 'Wandelnetwerken'];

const BUILDING_WORDS = [
  'molen', 'kasteel', 'kerk', 'kapel', 'belfort', 'toren', 'museum', 'brouwerij', 'abdij',
  'begraafplaats', 'cemetery', 'kerkhof', 'memorial', 'monument', 'gedenkteken', 'poort',
  'sluis', 'sluiz', 'stadhuis', 'halle', 'fort', 'trap', 'bezoekerscentrum',
  'kathedraal', 'begijnhof', 'basiliek', 'station', 'hoeve', 'herberg', 'café', 'cafe',
  'vuurtoren', 'bunker', 'schans', 'priorij', 'klooster', 'pastorie',
  'gebouw', 'paleis', 'woning', 'villa', 'standbeeld', 'beeld',
];

// Woorden die enkel als los woord tellen (anders matcht "brug" ook "Gentbrugse").
const BUILDING_WHOLE_WORDS = ['brug', 'sas'];

const normalize = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const inferPoiType = (point) => {
  const explicit = String(point?.Type ?? '').trim();
  if (POI_TYPES.includes(explicit)) return explicit;

  const text = normalize(`${point?.Title ?? ''} ${point?.Title2 ?? ''}`);
  if (!text.trim()) return null;
  if (/wandelnetwerk/.test(text)) return 'Wandelnetwerken';
  if (BUILDING_WORDS.some((word) => text.includes(word))) return 'Gebouwen';
  if (BUILDING_WHOLE_WORDS.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text))) return 'Gebouwen';
  return 'Locaties';
};

module.exports = { POI_TYPES, inferPoiType };
