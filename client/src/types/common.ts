/**
 * Common types — shared building blocks used by multiple domain modules.
 * Lives alone so message.ts, dm.ts, etc. can import without pulling
 * a wider domain into their dependency graph.
 */

/** Grouped emoji reaction info. */
export type ReactionGroup = {
  emoji: string;
  count: number;
  users: string[]; // user IDs
};
