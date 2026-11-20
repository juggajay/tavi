// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
export function safeLink(value: string) {
  try { const url = new URL(value, location.origin); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
const components: Components = {
  a: ({ href, children }) => <a href={safeLink(href ?? "")} target="_blank" rel="noreferrer noopener">{children}</a>,
  img: ({ alt }) => <span>{alt || "Picture"}</span>,
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
};
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
});
