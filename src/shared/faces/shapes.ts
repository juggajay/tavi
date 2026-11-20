// Ten original shapes for Tavi's bots: smooth stones and simple solids, drawn from scratch.
export const shapes = {
  pebble: "M16 56 C15 32 26 17 49 16 C72 14 86 29 86 53 C88 76 76 84 51 84 C29 85 16 77 16 56 Z",
  cobble: "M14 53 C11 36 23 20 40 17 C58 11 74 18 84 33 C96 49 85 70 72 80 C58 91 36 86 23 77 C14 69 16 60 14 53 Z",
  skimmer: "M9 59 C10 46 27 34 48 31 C68 28 89 36 92 50 C97 65 78 72 54 74 C30 76 10 73 9 59 Z",
  boulder: "M12 61 C10 40 17 18 39 12 C57 6 76 15 86 33 C98 54 91 78 73 86 C52 94 22 88 15 77 C12 73 12 68 12 61 Z",
  shard: "M20 23 C20 19 24 17 29 18 L78 28 C83 29 84 34 83 39 L75 81 C74 85 69 87 65 85 L17 72 C13 71 13 66 14 61 Z",
  marble: "M18 44 C23 24 42 14 57 19 C75 24 88 38 84 58 C82 76 63 87 45 82 C27 81 12 65 18 44 Z",
  moon: "M17 49 C10 35 23 23 37 24 C44 11 66 13 72 27 C90 30 94 49 83 61 C89 78 72 91 57 83 C40 93 19 82 22 67 C12 64 11 57 17 49 Z",
  lozenge: "M33 12 C41 8 61 9 68 15 C75 22 74 71 69 81 C65 92 39 94 31 83 C24 71 24 23 33 12 Z",
  sliver: "M11 71 L78 23 C82 20 85 22 86 27 L91 74 C92 79 88 83 83 83 L15 81 C8 81 6 75 11 71 Z",
  nugget: "M25 32 C28 17 46 14 58 21 C74 16 87 31 81 46 C91 60 78 79 63 79 C51 91 30 82 29 69 C12 64 13 42 25 32 Z",
} as const;
export const colours = {
  orange: ["#E8611A", "#FFC08F"], blue: ["#2F68DA", "#ADC8FF"], teal: ["#0C8A8E", "#8EE2DC"],
  slate: ["#4F7191", "#C2D5E6"], pink: ["#D1479C", "#FFBCE2"], sky: ["#1B8CD0", "#A6DDFA"],
  plum: ["#9450B4", "#DDBDF0"], green: ["#1FA45A", "#A6EDC0"],
} as const;
