/**
 * Fictional names for the demo world. Nothing here refers to a real person or business:
 * phone numbers use the 555-0100..0199 block reserved for fiction, emails use the reserved
 * `example.com` / `.example` domains.
 */

export const FIRST_NAMES = [
  'Alan',
  'Beth',
  'Carl',
  'Diane',
  'Earl',
  'Faye',
  'Glen',
  'Holly',
  'Ivan',
  'Joan',
  'Kurt',
  'Lena',
  'Marv',
  'Nora',
  'Otto',
  'Paula',
  'Ray',
  'Sue',
  'Vern',
  'Wanda',
] as const;

/** Landlord surnames (fictional). */
export const LANDLORD_SURNAMES = [
  'Kowalczyk',
  'Brenner',
  'Schaffert',
  'Van Hoven',
  'Lindqvist',
  'Ostrowe',
  'Petrakis',
  'Hollinger',
  'Duquette',
  'Marchetti',
  'Rasmussen',
  'Tillotson',
  'Abernath',
  'Wojcikow',
  'Feltner',
  'Gruenwald',
] as const;

/** Organizations that rent ground to the farm (fictional). */
export const LANDLORD_ORGS = ['Westerholt Family Trust', 'Brambleton Land LLC'] as const;

/** Section-line road names (fictional); N-S lines get "Hwy", E-W lines "Rd" (Lenawee style). */
export const ROAD_NAMES = [
  'Ashby',
  'Birchard',
  'Corwin',
  'Danforth',
  'Elsworth',
  'Fenmore',
  'Galloway',
  'Harrowgate',
  'Ingle',
  'Jessup',
  'Kettering',
  'Lorimer',
  'Mabry',
  'Norcross',
  'Oakmont',
  'Pelham',
  'Quarry',
  'Redfield',
  'Stanwick',
  'Thorne',
  'Upham',
  'Vickery',
  'Wexley',
  'Yardley',
  'Ambrose',
  'Bellamy',
  'Calder',
  'Dunmore',
  'Everly',
  'Fairbanks',
  'Gilchrist',
  'Hartwell',
  'Iverson',
  'Jennings',
  'Kingsley',
  'Lockwood',
  'Merriman',
  'Newbold',
  'Orchard',
  'Prescott',
] as const;

export interface CrewMember {
  key: string;
  first: string;
  last: string;
  /** What they run, for notes. */
  runs: string;
}

export const CREW: readonly CrewMember[] = [
  { key: 'crew-dale', first: 'Dale', last: 'Mercer', runs: 'combine C1' },
  { key: 'crew-luis', first: 'Luis', last: 'Ortega', runs: 'combine C2' },
  { key: 'crew-jake', first: 'Jake', last: 'Brandtner', runs: 'grain cart GC1' },
  { key: 'crew-amy', first: 'Amy', last: 'Kovach', runs: 'grain cart GC2, planter' },
  { key: 'crew-tom', first: 'Tom', last: 'Rietzel', runs: 'semi S1, sprayer' },
  { key: 'crew-ben', first: 'Ben', last: 'Fischbach', runs: 'semi S2' },
  { key: 'crew-sam', first: 'Sam', last: 'Okafor', runs: 'semi S3, drone' },
  { key: 'crew-kyle', first: 'Kyle', last: 'Dunleavy', runs: 'semi S4' },
];

/** The operation itself (fictional name for the demo). */
export const OWNER_ORG = { key: 'owner-home-farm', name: 'Home Farm (demo)' } as const;

export interface CustomerDef {
  key: string;
  name: string;
  short: string;
  contact: { first: string; last: string };
}

export const CUSTOMERS: readonly CustomerDef[] = [
  {
    key: 'customer-halvorsen',
    name: 'Halvorsen Bros. Farms',
    short: 'Halvorsen',
    contact: { first: 'Mark', last: 'Halvorsen' },
  },
  {
    key: 'customer-juniper-hill',
    name: 'Juniper Hill Farms LLC',
    short: 'Juniper Hill',
    contact: { first: 'Gail', last: 'Pressler' },
  },
];

export interface ElevatorDef {
  key: string;
  partyKey: string;
  name: string;
  /** Near this town (TOWNS key). */
  town: string;
  /** Rough location of the yard. */
  near: [number, number];
  merchandiser: { first: string; last: string };
}

export const ELEVATORS: readonly ElevatorDef[] = [
  {
    key: 'elevator-yard-kestrel',
    partyKey: 'elevator-kestrel',
    name: 'Kestrel Grain Co. (Blissfield)',
    town: 'blissfield',
    near: [-83.848, 41.836],
    merchandiser: { first: 'Rhonda', last: 'Kessel' },
  },
  {
    key: 'elevator-yard-tamarack',
    partyKey: 'elevator-tamarack',
    name: 'Tamarack Elevator (Petersburg)',
    town: 'petersburg',
    near: [-83.706, 41.893],
    merchandiser: { first: 'Doug', last: 'Ferrante' },
  },
  {
    key: 'elevator-yard-larkspur',
    partyKey: 'elevator-larkspur',
    name: 'Larkspur Grain (Dundee)',
    town: 'dundee',
    near: [-83.671, 41.949],
    merchandiser: { first: 'Lyle', last: 'Brandauer' },
  },
];

export const VENDOR = {
  key: 'vendor-bluestem-ag',
  name: 'Bluestem Ag Supply',
} as const;

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Fictional phone in the reserved 555-01xx block: (517) for Lenawee, (734) for Monroe. */
export function fictionalPhone(areaCode: '517' | '734', n: number): string {
  const line = 100 + (n % 100);
  return `(${areaCode}) 555-0${line}`;
}
