// Whether conversations open translated: 自動翻譯 or 手動切換. The board keeps it for every device.
export const TRANSLATE_MODES = ['auto', 'manual'] as const;
export type TranslateMode = (typeof TRANSLATE_MODES)[number];
