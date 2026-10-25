/** The single-destination shell is the default; literal false enables rollback. */
export const isUiShellV2Enabled = (value: string | undefined): boolean => value !== "false";

export const UI_SHELL_V2 = isUiShellV2Enabled(import.meta.env.VITE_UI_SHELL_V2);
