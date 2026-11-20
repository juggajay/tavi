import { DAYS, hex } from "../palette";
type RGB = [number, number, number];
const lum = (c: RGB) => c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
export function contrast(a: RGB,b: RGB) { const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
// The interface always uses orange. A caller keeps its base and tint for the face.
export function derive(base: RGB,tint: RGB) {
  const ring=hex("#A63B10"),fillL=hex("#B74717"),onL=hex("#FFF7EF"),inkL=ring;
  const fillD=hex("#F78A4F"),onD=hex("#211D1B"),inkD=hex("#FFA16E");
  return {base,tint,ring,fillL,onL,inkL,fillD,onD,inkD,checks:{
    ringWhite:contrast(ring,hex("#FFFFFF")),ringPaperDark:contrast(ring,hex("#E5E6E2")),
    btnL:contrast(fillL,onL),btnD:contrast(fillD,onD),inkL:contrast(inkL,hex("#F3F4F2")),inkD:contrast(inkD,hex("#15181B")),
  }};
}
export function report() { return DAYS.map(d=>({day:d.short,name:d.name,...derive(hex(d.base),hex(d.tint)).checks})); }
