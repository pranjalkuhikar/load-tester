# Generated tests

Created by **TestLab** for `load-tester`. Put this folder at `<project>/tests-generated/` (the unit tests import your source with relative paths).

| Folder | What it is | Run |
|---|---|---|
| `unit/` | Characterization tests: each function was run with edge inputs in a sandbox and its real result is pinned | `node --test "tests-generated/unit/*.test.mjs"` |
| `integration/` | Real HTTP requests per endpoint: lifecycles, bad IDs, validation, security, auth | `BASE_URL=http://localhost:3000 node --test "tests-generated/integration/*.test.mjs" "tests-generated/contract/*.test.mjs"` |
| `contract/` | Response-shape tests + Pact files (`pacts/*.json`) and a verifier that replays them | same as above |
| `*.ai.test.mjs` | **AI-assisted** (only if AI review was on): extra inputs recorded from the real code, plus `[AI finding]` tests that FAIL until a suspected bug is fixed. See `AI-FINDINGS.md` | same commands |
| `e2e/` | Playwright browser tests (needs `npm i -D @playwright/test`) | `BASE_URL=http://localhost:3000 npx playwright test --config tests-generated/e2e/playwright.config.mjs` |

## Please read
- **Integration and contract tests send real requests.** POST/PUT/PATCH/DELETE change data in the app. Run them against a development database.
- **Characterization tests pin current behaviour, not correct behaviour.** Read each expected value and fix the code (not the test) when the pinned behaviour is a bug.
- Environment variables: `BASE_URL`, `BASE_URL_<SERVICE>` (per service), `TEST_TOKEN` (bearer token for protected routes), `EXPECT_AUTH=1`.
- Generated with the **node:test** runner. (With `node --test`, keep the quotes around the patterns; they need Node 21+. On Node 20 run `node --test tests-generated/`.)
