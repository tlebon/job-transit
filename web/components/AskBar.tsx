"use client";

import { useState } from "react";

/** The guide's front door on the map view: asking a question switches to the chat. */
export function AskBar({ onAsk }: { onAsk: (question: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="ask-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAsk(text.trim());
      }}
    >
      <input
        className="field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the guide about your next move: “Where could I go that pays more?”"
        aria-label="Ask the guide"
      />
      <button type="submit" className="action" disabled={!text.trim()}>
        Ask
      </button>
    </form>
  );
}
