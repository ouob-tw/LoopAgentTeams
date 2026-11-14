/** Where host commands run, as a page names it: the board folder, never its absolute path, which
 *  pages served before login must not give away. */
export const BOARD_FOLDER = '主機的看板資料夾（board/）';

/** A host command, run from the board folder. */
export const hostCommand = (args: string) => `bun run board ${args}`;
