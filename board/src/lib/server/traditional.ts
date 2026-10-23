// Chinese as used in Taiwan, whatever Codex or the speech recognition service wrote.
import * as OpenCC from 'opencc-js/cn2t';

/** Taiwan's standard, with its own words (软件 → 軟體), not only its characters. */
export const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** Taiwan's characters only; the speaker's words stay (软件 → 軟件). */
export const toTraditionalChars = OpenCC.Converter({ from: 'cn', to: 'tw' });
