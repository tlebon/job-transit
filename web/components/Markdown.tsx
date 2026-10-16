import { Fragment, type ReactNode } from "react";

/** Just enough Markdown for the guide's replies: paragraphs, bullet and numbered lists, headings, tables,
 * **bold**, [links](https://...) and bare https:// links. A paragraph line followed by list lines (a label, then
 * its items) renders as a paragraph and a list. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.length >= 2 && lines.every((l) => l.trim().startsWith("|"))) {
          const rows = lines
            .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))           // drop the |---|---| separator
            .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
          const [head, ...body] = rows;
          return (
            <div key={i} className="md-table">
              <table>
                <thead>
                  <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {body.map((r, k) => (
                    <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <Fragment key={i}>{runs(lines)}</Fragment>;
      })}
    </>
  );
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;
const HEADING = /^#{1,4}\s/;

/** Consecutive lines of the same kind (list items, plain text) become one list or one paragraph. */
function runs(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let run: string[] = [];
  let kind: "ul" | "ol" | "p" | null = null;
  const flush = () => {
    if (!run.length || !kind) return;
    const key = out.length;
    if (kind === "p") {
      out.push(
        <p key={key}>
          {run.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(l)}
            </Fragment>
          ))}
        </p>,
      );
    } else {
      const items = run.map((l, j) => <li key={j}>{inline(l.replace(LIST_ITEM, ""))}</li>);
      out.push(kind === "ol" ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    }
    run = [];
  };
  for (const line of lines) {
    if (HEADING.test(line)) {
      flush();
      kind = null;
      out.push(
        <p key={out.length} className="md-heading">
          {inline(line.replace(/^#+\s*/, ""))}
        </p>,
      );
      continue;
    }
    const k = LIST_ITEM.test(line) ? (/^\s*\d/.test(line) ? "ol" : "ul") : "p";
    if (k !== kind) {
      flush();
      kind = k;
    }
    run.push(line);
  }
  flush();
  return out;
}

// [text](https://...), **bold** (may contain links), or a bare https:// link. Only http(s) links are made clickable.
const TOKEN = /(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<\]]+[^\s)<\].,;:!?])/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = out.length;
    if (m[1]) out.push(<strong key={key}>{inline(m[1].slice(2, -2))}</strong>);
    else if (m[2] && m[3]) out.push(<a key={key} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>);
    else if (m[4]) out.push(<a key={key} href={m[4]} target="_blank" rel="noreferrer">{shortUrl(m[4])}</a>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function shortUrl(url: string) {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "");
  return bare.length > 40 ? `${bare.slice(0, 38)}…` : bare;
}
