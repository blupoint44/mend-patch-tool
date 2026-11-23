# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/blupoint44/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/blupoint44/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one CLI that applies the edits AI models write — in every format they write them in — to a tree of text files. It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON, all to one written specification, and applies them with the exact exit codes, output lines and file results that specification promises.

Models get edits wrong in predictable ways, so mend matches the lines an edit names through three tiers: exact, trailing-whitespace-insensitive, and fully trimmed with re-indentation of the replacement onto the file's own indentation. Unified hunks whose line numbers have drifted land on the occurrence nearest the stated position, CRLF files keep their line breaks, files without a final line break keep that too, and prose or code fences around a patch are ignored.

Every edit in a patch is attempted and every failure is reported, but the write is all-or-nothing: if any edit fails, no file is created, changed, moved or deleted. Paths are checked for safety before anything else, and `--check` reports exactly what a real run would do without writing a byte. mend runs on Node 22 with the standard library alone — no dependencies, no network, deterministic output.

This entry was built for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — join via the referral link [make.fun/?ref=cc9ads3n](https://make.fun/?ref=cc9ads3n). Final practice score: 100 of 100 checks passed (practice score 1000).

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cc9ads3n&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
