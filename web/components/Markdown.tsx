import { Fragment, type ReactNode } from "react";

/** Just enough Markdown for the guide's replies: paragraphs, bullet and numbered lists, **bold**, headings. */
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
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if (lines.length === 1 && /^#{1,4}\s/.test(lines[0])) {
          return <p key={i} className="md-heading">{inline(lines[0].replace(/^#+\s*/, ""))}</p>;
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}
