import type { BotIcon } from "./types.js";

export type { BotIcon } from "./types.js";

// Twelve original characters, one from each of the first draft's labels.
// Labels describe the characters; they are not a category browsing API.
export const ICONS: BotIcon[] = [
  {
    "id": "ocean-drifters/jellyfish",
    "name": "Jellyfish",
    "category": "Ocean drifters",
    "body": "M10 53 C9 29 25 12 47 12 C74 10 91 30 90 53 Q89 62 77 60 L77 79 Q75 90 68 84 L65 61 L57 62 L55 87 Q49 95 45 85 L42 62 L34 62 L31 82 Q25 90 21 82 L23 61 Q9 65 10 53 Z",
    "eyes": {
      "x": 50,
      "y": 42,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "breakfast-club/toast",
    "name": "Toast",
    "category": "Breakfast club",
    "body": "M21 41 C12 38 10 29 16 22 C24 10 42 10 50 16 C61 9 78 14 84 23 C90 32 85 39 79 42 L80 79 Q80 88 69 88 L30 87 Q20 87 20 77 Z",
    "marks": [
      "M50 20 C61 14 75 18 81 26 Q86 34 76 39 L76 77 Q76 84 68 84 L31 83 Q24 83 24 76 L25 39 Q14 35 19 26 C25 16 41 14 50 20 L50 28 C39 22 30 23 26 29 Q23 33 32 34 L32 74 Q32 76 35 76 L65 77 Q69 77 69 74 L69 34 Q79 34 74 29 C69 24 59 22 50 28 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 50,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "fruit-bowl/pear",
    "name": "Pear",
    "category": "Fruit bowl",
    "body": "M43 23 Q42 15 47 10 Q52 7 56 12 Q50 16 52 24 Q68 22 71 42 Q74 50 83 61 Q96 82 71 89 Q46 95 24 85 Q8 74 21 57 Q32 46 32 35 Q33 24 43 23 Z",
    "eyes": {
      "x": 50,
      "y": 60,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "sweet-counter/wrapped-sweet",
    "name": "Wrapped sweet",
    "category": "Sweet counter",
    "body": "M27 35 C32 14 64 11 74 34 L86 25 Q94 21 92 31 L89 44 Q95 50 89 57 L92 71 Q95 81 85 76 L73 65 C64 87 34 88 26 65 L14 76 Q5 81 8 71 L11 56 Q5 50 11 44 L8 30 Q6 21 15 26 Z",
    "marks": [
      "M23 39 Q27 36 30 35 Q35 50 30 65 L23 61 Q27 50 23 39 Z",
      "M71 35 L78 40 Q74 50 78 61 L71 66 Q66 51 71 35 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 50,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "night-neighbours/bat",
    "name": "Bat",
    "category": "Night neighbours",
    "body": "M34 32 L34 16 Q35 9 41 15 L50 25 L59 14 Q65 9 67 17 L67 32 C77 25 86 25 92 29 Q94 32 90 37 C81 43 80 52 83 62 Q84 67 78 64 C70 59 64 64 61 73 Q56 87 50 89 Q44 87 39 73 C34 62 26 60 20 65 Q14 69 16 62 C19 51 16 42 9 36 Q4 29 12 27 Q24 25 34 32 Z",
    "eyes": {
      "x": 50,
      "y": 47,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "laundry-day/sock",
    "name": "Sock",
    "category": "Laundry day",
    "body": "M47 13 Q63 9 80 14 L81 57 Q92 72 78 82 L46 91 Q26 96 17 84 Q9 73 19 64 L43 49 Z",
    "marks": [
      "M48 19 L79 19 L79 27 L47 27 Z",
      "M21 65 Q33 67 36 86 Q24 89 18 81 Q13 73 21 65 Z"
    ],
    "eyes": {
      "x": 62,
      "y": 39,
      "gap": 16,
      "r": 3.8
    }
  },
  {
    "id": "paper-parade/open-book",
    "name": "Open book",
    "category": "Paper parade",
    "body": "M12 20 Q32 13 50 25 Q67 13 87 21 Q92 23 91 32 L88 79 Q87 87 79 83 Q62 77 50 87 Q34 78 19 83 Q9 86 9 76 L8 31 Q7 22 12 20 Z",
    "marks": [
      "M46 31 Q51 28 54 32 L54 77 L47 78 Z",
      "M19 65 Q29 61 39 65 L39 73 Q28 69 19 73 Z",
      "M62 65 Q73 61 82 65 L81 73 Q72 69 62 73 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 47,
      "gap": 28,
      "r": 3.8
    }
  },
  {
    "id": "music-room/bell",
    "name": "Bell",
    "category": "Music room",
    "body": "M43 21 Q39 9 49 9 Q61 9 58 22 Q78 26 78 50 L82 64 Q94 68 90 77 Q87 83 61 82 Q58 94 48 92 Q40 91 38 82 Q10 82 9 74 Q6 67 18 63 L23 47 Q24 24 43 21 Z",
    "marks": [
      "M24 69 Q49 73 76 68 L80 75 Q49 81 20 75 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 50,
      "gap": 20,
      "r": 3.8
    }
  },
  {
    "id": "space-outing/rocket",
    "name": "Rocket",
    "category": "Space outing",
    "body": "M44 11 Q50 6 57 12 C68 23 73 39 71 56 L82 66 Q88 72 88 83 Q88 88 82 86 L66 78 L62 76 L61 84 Q61 89 55 89 L46 89 Q40 89 40 83 L39 76 L34 78 L18 87 Q11 91 12 82 Q12 71 20 63 L28 55 C26 36 32 20 44 11 Z",
    "marks": [
      "M35 26 Q50 14 65 26 L68 34 Q51 25 32 35 Z",
      "M33 63 L66 63 L64 72 L34 72 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 45,
      "gap": 17,
      "r": 3.8
    }
  },
  {
    "id": "pond-pals/turtle",
    "name": "Turtle",
    "category": "Pond pals",
    "body": "M33 30 C30 17 38 9 49 9 C62 8 70 18 66 31 Q73 34 76 41 L85 33 Q93 28 93 37 Q92 47 80 52 Q81 64 73 74 L81 81 Q85 89 76 89 L63 82 Q50 90 36 82 L24 88 Q15 91 17 82 L25 73 Q18 62 21 51 Q8 46 7 37 Q6 29 14 33 L25 41 Q28 34 33 30 Z",
    "marks": [
      "M50 37 C72 37 79 53 72 69 C66 82 37 83 29 67 C22 50 30 37 50 37 L50 45 C35 45 30 54 37 67 C43 76 59 75 65 65 C71 52 62 45 50 45 Z",
      "M45 50 Q50 47 55 50 L59 58 L55 66 Q50 69 45 66 L41 58 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 25,
      "gap": 16,
      "r": 3.8
    }
  },
  {
    "id": "game-cupboard/gamepad",
    "name": "Gamepad",
    "category": "Game cupboard",
    "body": "M27 19 C35 16 42 22 49 22 C60 21 65 16 75 21 Q85 27 89 46 L93 72 Q95 84 86 87 Q78 90 70 78 L62 67 L39 67 L27 82 Q18 91 11 82 Q6 76 10 61 L16 35 Q19 22 27 19 Z",
    "marks": [
      "M25 47 L31 47 L31 53 L37 53 L37 59 L31 59 L31 65 L25 65 L25 59 L19 59 L19 53 L25 53 Z",
      "M70 49 C70 42 82 42 82 49 C82 57 70 57 70 49 Z",
      "M61 61 C61 55 71 55 71 61 C71 68 61 68 61 61 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 36,
      "gap": 18,
      "r": 3.8
    }
  },
  {
    "id": "odd-company/pocket-yeti",
    "name": "Pocket yeti",
    "category": "Odd company",
    "body": "M26 20 Q33 9 42 19 Q51 8 61 20 Q75 13 79 29 L78 41 Q91 47 92 67 Q91 77 82 72 L74 63 L75 86 Q72 94 60 91 L52 76 L44 91 Q32 96 26 87 L26 66 L18 75 Q7 77 8 65 Q8 45 22 39 Z",
    "marks": [
      "M37 64 C37 53 63 53 64 65 Q63 77 51 78 Q38 78 37 64 Z"
    ],
    "eyes": {
      "x": 50,
      "y": 44,
      "gap": 20,
      "r": 3.8
    }
  }
];

const byId = new Map(ICONS.map(icon => [icon.id, icon]));

/** Unknown or retired choices keep a friendly, predictable face. */
export function iconById(id: string): BotIcon {
  return byId.get(id) ?? ICONS[0];
}

/** FNV-1a over UTF-16 code units: stable across browsers and reloads. */
export function randomIcon(seed: string): BotIcon {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  return ICONS[hash % ICONS.length];
}

