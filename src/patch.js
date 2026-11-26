// Builds a patch for `git apply --cached --recount` from one hunk of a parsed diff,
// keeping only the selected change lines.
//
// reverse=false: patch is applied forward (stage from a worktree diff).
// reverse=true:  patch is applied with --reverse (unstage from a staged diff, or discard from a
//                worktree diff). Unselected '+' lines then exist on the target side, so they stay
//                as context; unselected '-' lines don't, so they are dropped.
export function buildPatch(file, hunk, selected = null, reverse = false) {
  const body = [];
  let lastKept = true;
  hunk.lines.forEach((l, i) => {
    if (l.t === '\\') {
      if (lastKept) body.push(l.raw);
      return;
    }
    if (l.t === ' ' || !selected || selected.has(i)) {
      body.push(l.raw);
      lastKept = true;
      return;
    }
    const keepAsContext = reverse ? l.t === '+' : l.t === '-';
    if (keepAsContext) body.push(' ' + l.raw.slice(1));
    lastKept = keepAsContext;
  });
  if (!body.some((r) => r[0] === '+' || r[0] === '-')) return null;
  return [...file.header, hunk.header, ...body].join('\n') + '\n';
}
