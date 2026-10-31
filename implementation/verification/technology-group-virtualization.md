# Group DM rendering

Histories above 80 visible messages use TanStack Virtual with stable message IDs, measured row heights and overscan. Message/reply and member lookups use identity maps. Prepending history preserves the visible anchor. Jump targets mount before highlighting; focused rows remain mounted when scrolling and retain DOM focus. Article position/total metadata describes the virtual sequence. Small/filter-result lists retain ordinary rendering. No history trimming, pagination or decryption change.

Validation: TypeScript; 47 component tests; explicit 2000-message benchmark. Same-host jsdom samples show 2000 to 17 mounted articles and 30020 to 276 elements; this measures React/DOM mount cost, not browser paint. Browser fixture separately passed prepend anchor (0px movement), distant jump/reply preview, height changes above viewport (0px movement), focused row retention and search with full history retained. See accompanying JSON evidence. Actual assistive technology and attachment-download acceptance remain outside this synthetic fixture.

Rollback: revert this PR; store and persisted history formats are unchanged. Reproduce mount comparison with HICHAT_GROUP_BENCHMARK=1 and the `measures long group history rendering` Vitest filter, --silent=false.
