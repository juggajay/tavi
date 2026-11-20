export const core = { orange: "#E96324", green: "#209864", blue: "#2876C8", charcoal: "#17181D", stone: "#F4E7D9" };
export const themes = {
  light: {
    bg:"#F5EEE5", raised:"#FFFAF4", sunk:"#EDE4DA", hover:"#E4D8CC", pressed:"#D9CABE",
    ink:"#27252B", "ink-2":"#514C49", "ink-3":"#62564F", line:"#C9BBB0", "line-2":"#85766D",
    accent:"#B74717", "accent-ink":"#A63B10", "accent-hover":"#A23D11", "accent-pressed":"#8F330D", "on-accent":"#FFF7EF", "accent-soft":"#F2D8C7", ring:"#A63B10",
    ok:"#216744", "ok-soft":"#DCEBDD", warn:"#755409", "warn-soft":"#F4E6BC", bad:"#B02C43", "bad-soft":"#F6DDE2",
    paper:"#FFFAF4", "paper-ink":"#27252B", "paper-2":"#62564F", "paper-fill":"#EDE4DA", desk:"#E4D8CC",
  },
  dark: {
    bg:"#17181D", raised:"#202127", sunk:"#131419", hover:"#34343B", pressed:"#3D3A41",
    ink:"#F4E7D9", "ink-2":"#D0C3B8", "ink-3":"#B6ABA2", line:"#49454A", "line-2":"#92888C",
    accent:"#F78A4F", "accent-ink":"#FFA16E", "accent-hover":"#FFA16E", "accent-pressed":"#EC7435", "on-accent":"#211D1B", "accent-soft":"#443025", ring:"#FFA16E",
    ok:"#83D3A2", "ok-soft":"#253A2E", warn:"#F0CE7D", "warn-soft":"#3C3421", bad:"#FFA0B1", "bad-soft":"#432832",
    paper:"#EDE4DA", "paper-ink":"#27252B", "paper-2":"#62564F", "paper-fill":"#D9CABE", desk:"#101115",
  },
};
export const textPairs = [
  ...["ink", "ink-2", "ink-3", "accent-ink", "ok", "warn", "bad"].flatMap(text => ["bg","raised","sunk","hover"].map(bg => [text,bg,4.5])),
  ...["accent","accent-hover","accent-pressed"].map(bg => ["on-accent",bg,4.5]),
  ["ink","accent-soft",4.5],["ok","ok-soft",4.5],["warn","warn-soft",4.5],["bad","bad-soft",4.5],
  ["paper-ink","paper",4.5],["paper-2","paper",4.5],["paper-ink","paper-fill",4.5],
  ...["bg","raised","sunk","hover"].flatMap(bg => [["ring",bg,3],["line-2",bg,3],["accent",bg,3]]),
];
