export type BotIcon = {
  id: string;
  name: string;
  category: string;
  body: string;
  marks?: string[];
  cut?: string[];
  eyes: { x: number; y: number; gap: number; r: number };
};
