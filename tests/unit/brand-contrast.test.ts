import "../isolate.js";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
const {themes,textPairs,core}=await import(pathToFileURL(path.resolve("ui/src/shared/brand/palette.mjs")).href);
const luminance=(hex:string)=>hex.match(/[a-f\d]{2}/gi)!.map(n=>parseInt(n,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
const ratio=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const css=readFileSync("ui/src/shared/tokens.css","utf8");
for(const [theme,tokens] of Object.entries(themes) as [string,Record<string,string>][]){
  for(const [key,value]of Object.entries(tokens))assert.ok(css.includes("--"+key+":"+value+";"),theme+" "+key+" is applied");
  for(const [text,bg,min]of textPairs as [string,string,number][]){
    const r=ratio(tokens[text],tokens[bg]);assert.ok(r>=min,theme+" "+text+" on "+bg+": "+r.toFixed(2)+" needs "+min);
  }
  for(const status of ["ok","warn","bad"])assert.notEqual(tokens[status],tokens.accent);
}
for(const [key,value]of Object.entries(core))assert.ok(css.includes("--brand-"+key+":"+value));
console.log("Both themes pass all declared text, focus, control and state pairings.");
