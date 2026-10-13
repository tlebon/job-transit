// Each occupation family is a metro line. Colors picked to read as a transit map, distinct in light and dark.
export const LINES: Record<string, { code: string; color: string }> = {
  "Management and business": { code: "M", color: "#7B4FA3" },
  "Computer, engineering, science": { code: "C", color: "#0A6FBF" },
  "Education, legal, social, arts": { code: "E", color: "#D61F7A" },
  Healthcare: { code: "H", color: "#0E9F5B" },
  Service: { code: "S", color: "#E5810B" },
  "Sales and office": { code: "O", color: "#8A6A47" },
  "Trades, production, transport": { code: "T", color: "#5E6A75" },
};

export const lineOf = (family: string | null) =>
  (family && LINES[family]) || { code: "?", color: "#8A9199" };
