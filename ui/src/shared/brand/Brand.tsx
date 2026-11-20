import mark from "./mark.svg";
import small from "./mark-small.svg";
import word from "./wordmark.svg";
import line from "./wordmark-line.svg";
import family from "./family.svg";
export function BrandMark({ size = 36, compact = false }: { size?: number; compact?: boolean }) {
  return <img src={compact ? small : mark} width={size} height={size} alt="" />;
}
export function Wordmark({ tagline = false }: { tagline?: boolean }) {
  return <img className="brand-wordmark" src={tagline ? line : word} width={tagline ? 270 : 80} height={tagline ? 132 : 30} alt={tagline ? "Tavi. Your own small team." : "Tavi"} />;
}
export function BrandFamily() { return <img src={family} width="330" height="175" alt="" />; }
