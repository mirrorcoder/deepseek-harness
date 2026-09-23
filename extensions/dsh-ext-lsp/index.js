// dsh-ext-lsp is a pure bundle: everything it adds is the three upstream rows
// in cordis.patch.yml. This module exists only because a bundle package needs
// an entry point; it mounts nothing of its own.
export const name = 'ext-lsp'
export function apply() {}
