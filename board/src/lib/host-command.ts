/** A host command that runs from any directory: it goes to the board's own directory first. */
export function hostCommand(boardDir: string, args: string): string {
	// Single quotes only when the path needs them, so an ordinary path reads plainly.
	const dir = /^[\w@%+=:,./-]+$/.test(boardDir) ? boardDir : `'${boardDir.replaceAll("'", `'\\''`)}'`;
	return `cd ${dir} && bun run board ${args}`;
}
