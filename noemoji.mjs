// House rule: zero emoji in anything the company publishes (sites, apps, products, posts, emails). Icons only.
// Keeps typographic symbols that are not emoji-styled on their own: © ® ™ and the plain arrows ↔ ↕ ↖ ↗ ↘ ↙ ↩ ↪.
const KEEP = new Set([0xa9, 0xae, 0x2122, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199, 0x21a9, 0x21aa]);
const RUN = /(?:[\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic})(?:️|︎|‍|⃣|\p{Emoji_Modifier}|[\u{1F1E6}-\u{1F1FF}]|[\u{E0020}-\u{E007F}]|\p{Extended_Pictographic})*/gu;
const KEYCAP = /[0-9#*]️?⃣/gu;

const isEmojiRun = (m) => { const cps = [...m]; return !(cps.length === 1 && KEEP.has(cps[0].codePointAt(0))); };

export function stripEmoji(s) {
  if (typeof s !== "string" || !s) return s;
  return s.replace(KEYCAP, (m) => m[0]).replace(RUN, (m) => (isEmojiRun(m) ? "" : m)).replace(/️/g, "");
}
export function countEmoji(s) {
  if (typeof s !== "string" || !s) return 0;
  let n = 0; for (const m of s.matchAll(RUN)) if (isEmojiRun(m[0])) n++;
  return n + (s.match(KEYCAP) || []).length;
}
/** Text files the company publishes (html, css, js, jsx, tsx, json, md, txt, svg). */
export const PUBLISHABLE = /\.(html?|css|m?js|jsx|tsx?|json|md|txt|svg|xml)$/i;
