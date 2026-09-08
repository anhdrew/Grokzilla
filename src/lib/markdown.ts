/** Split markdown so completed top-level blocks stay byte-stable while a tail grows. */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [""];
  const blocks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  let i = 0;
  while (i < text.length) {
    const atLine = i === 0 || text[i - 1] === "\n";
    if (atLine && (text.startsWith("```", i) || text.startsWith("~~~", i))) {
      const mark = text.slice(i, i + 3);
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
    }
    if (!fence && text[i] === "\n" && text[i + 1] === "\n") {
      blocks.push(text.slice(start, i));
      start = i + 2;
      i += 2;
      continue;
    }
    i += 1;
  }
  blocks.push(text.slice(start));
  return blocks;
}
