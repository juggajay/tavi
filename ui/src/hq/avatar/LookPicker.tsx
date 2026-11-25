import { BotFace } from "./BotAvatar";
import { lookChoices, colours } from "../../../../src/hq/looks/choices";
import { ICONS, randomIcon } from "./library";

export function unusedIcon(used: string[], seed = crypto.randomUUID()) {
  const first = ICONS.indexOf(randomIcon(seed));
  return Array.from({ length: ICONS.length }, (_, n) => ICONS[(first + n) % ICONS.length]).find(icon => !used.includes(icon.id))?.id ?? ICONS[first].id;
}

export function LookPicker({ shape, colour, setShape, setColour, used = [] }: {
  shape: string; colour: string; setShape: (shape: string) => void; setColour: (colour: string) => void; used?: string[];
}) {
  const choices = lookChoices;
  return <fieldset className="look-picker"><legend>Look</legend><button className="link-btn" type="button" onClick={() => setShape(unusedIcon([...used, shape]))}>Surprise me</button><div className="shape-picker">{choices.map(choice => <button type="button" key={choice.id} aria-label={`${choice.label} ${choice.name}`} aria-pressed={shape === choice.id} onClick={() => setShape(choice.id)}><BotFace shape={choice.id} colour={colour} size={40} ring={shape === choice.id} /><span>{choice.name}</span></button>)}</div><div className="colour-picker" aria-label="Colour">{Object.entries(colours).map(([key, [base]]) => <button type="button" key={key} aria-label={`Colour ${key}`} aria-pressed={key === colour} style={{ background: base }} onClick={() => setColour(key)} />)}</div></fieldset>;
}
