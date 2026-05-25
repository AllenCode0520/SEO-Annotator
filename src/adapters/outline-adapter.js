export function readOutlineSections(proposedOutline) {
  if (!Array.isArray(proposedOutline)) return [];

  return proposedOutline.map((section, index) => ({
    index,
    h2: String(section?.h2 ?? section?.title ?? "").trim(),
    keyClaims: Array.isArray(section?.key_claims) ? section.key_claims.map(String) : [],
    sourceHints: Array.isArray(section?.source_hints) ? section.source_hints.map(String) : [],
  }));
}

export function matchSectionForH2(sections, heading) {
  const target = String(heading ?? "").trim();
  if (!target) return null;

  return sections.find((section) => section.h2 === target)
    ?? sections.find((section) => target.includes(section.h2) || section.h2.includes(target))
    ?? null;
}
